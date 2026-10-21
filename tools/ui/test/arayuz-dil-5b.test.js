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
const DATE_ISO = '2026-02-03T10:20:00Z';
const MINUS = '−';

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

/** Summary: Tarayıcı kipi I18n ile aynı I18n'e bağlı Rules örneğini ve çeviri global'lerini (I18n, tx, th) döner. */
function browserEnv() {
  const g = uiGlobals({ browser: true });
  const ctx = vm.createContext({ I18n: g.I18n, FM });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'rules.js'), 'utf8'), ctx, { filename: 'rules.js' });
  return { ...g, Rules: ctx.Rules };
}

/** Summary: İşlev ve const kaynaklarını tek vm bağlamında çalıştırır; expose adları bağlam özelliği olur. */
function load({ fns = [], consts = [], expose = [] }, globals = {}) {
  const ctx = vm.createContext(Object.assign({ FM, Rules, console }, globals));
  vm.runInContext([...consts.map(constSrc), ...fns.map(fnSrc), ...expose.map((n) => 'this.' + n + ' = ' + n + ';')].join('\n'), ctx);
  return ctx;
}

/** Summary: fn'i sırayla tr, en, tr dilinde çalıştırır; ilk iki sonucu { tr, en } döner, üçüncü çalıştırmanın tr ile aynı olduğunu denetler. */
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
  return { attrs: {}, innerHTML: '', textContent: '', title: '', hidden: false, className: '', value: '', setAttribute(k, v) { this.attrs[k] = v; }, focus() {}, select() {} };
}

/** Summary: Seçiciye göre sabit öğe veren `$` saplaması ve öğe tablosu. */
function fakeDom() {
  const els = {};
  return { els, $: (s) => (els[s] = els[s] || fakeEl()) };
}

/** Summary: vm gerçeğinden gelen değeri test gerçeğine taşır. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Summary: Kullanıcı girdisi içermeyen, kalıcı alanları dolu örnek prompt dosyası. */
const SAMPLE = '---\nbaslik: A\nversiyon: 1.0.0\netiketler: [x, y]\ndurum: kararlı\ntur: komut\nkomut_adi: foo\n---\nGövde {{v1}} ve {{v2}}';

/** Summary: Açık dosya (S.cur) örneği. */
function makeCur(raw, extra = {}) {
  return { mp: 'mp', path: 'prompts/plug/a.md', isPrompt: true, isMd: true, parsed: FM.parse(raw), savedRaw: raw, lead: '', publish: null, dirty: false, commitMsg: '', tab: 'edit', mtime: 1, ...extra };
}

/** Summary: Editör, ana alan ve geçmiş kaynaklarının yüklü olduğu vm bağlamı (DOM saplamalı). */
function mainCtx(raw = SAMPLE, curExtra = {}, sExtra = {}) {
  const g = browserEnv();
  const dom = fakeDom();
  const c = makeCur(raw, curExtra);
  const S = {
    info: { activeMarketplace: 'mp', config: { marketplace: { plugin: 'varsayilan' }, export: { durumlar: ['kararlı', ''] } } },
    cur: c, git: { isRepo: true, files: [] }, facets: { total: 0 }, recent: [], ...sExtra
  };
  const ctx = load({
    fns: ['editPaneHtml', 'chipsHtml', 'curCheck', 'exportCheck', 'pubPill', 'bodyInfoText', 'rawPaneHtml', 'histPaneHtml', 'histModeBar', 'histCommitHtml', 'histVerHtml',
      'crumbsHtml', 'renderMainInner', 'startHtml', 'fieldLabel', 'verTimelineHtml', 'verCardHtml', 'verViewHtml', 'fieldCellsHtml', 'wordDiffHtml', 'verCompareHtml', 'verMainHtml'],
    consts: ['esc', 'str', 'toList', 'base', 'stem', 'fold', 'normTur', 'curNotice', 'HIST_STALE', 'verLabel', 'verByTag', 'FIELD_LABEL_KEYS', 'fmtDate', 'activeName', 'whereOf', 'durumClass'],
    expose: ['verLabel', 'fmtDate']
  }, {
    ...g, S, $: dom.$, ls: { get: (k, d) => d }, libDirOf: () => 'prompts', computeRaw: () => FM.stringify(c.parsed), uncommitted: () => false, saveLabel: () => 'SAVE',
    autosize() {}, paintPaketHint() {}, paintVerHint() {}, paintVerWarn() {}, paintHist() {}
  });
  return { ctx, g, S, c, dom };
}

/** Summary: Etiket ve metin düğümlerini ayıklayıp yalnızca işaretleme iskeletini bırakır. */
function skeleton(text) {
  return text.replace(/>[^<]*</g, '><').replace(/(?:title|aria-label|placeholder)="[^"]*"/g, '');
}

/** Summary: Verilen select içindeki option metninin value değerini döner. */
function optionValue(markup, selectId, text) {
  const select = new RegExp('<select id="' + selectId + '"[\\s\\S]*?</select>').exec(markup);
  assert.ok(select, selectId + ' bulunamadı');
  const found = [...select[0].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].find((m) => m[2] === text);
  return found ? found[1] : undefined;
}

/** Summary: Verilen select içindeki tüm option value değerlerini sırayla döner. */
function optionValues(markup, selectId) {
  const select = new RegExp('<select id="' + selectId + '"[\\s\\S]*?</select>').exec(markup);
  assert.ok(select, selectId + ' bulunamadı');
  return [...select[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
}

const EDIT_TR = [
  '<label>Etiketler</label>', '<label for="fDurum2">Durum</label>', '>Belirsiz</option>', '>Taslak</option>', '>Kararlı</option>', '>Arşiv</option>',
  '<label for="fVer">Sürüm</label>', 'placeholder="Henüz sürüm yok (+1 ile 1.0.0)"', 'title="Yeni sürüm oluştur: versiyon artar, commit ve tag atılır"',
  '<label>Projeler</label>', '<summary><b>Claude Code yayın ayarları</b>', '<label for="pTur">Tür</label>', '>Yayın dışı</option>', '>Komut (slash command)</option>',
  '>Ajan (subagent)</option>', '>Skill</option>', '<label for="pPaket">Paket</label>', '>Paket: plug (klasörden)</span>', '<label for="pAd">Ad</label>',
  '<label for="pAcik">Açıklama</label>', 'placeholder="Bu prompt ne işe yarar? Claude ne zaman kullanmalı?"', '<label for="pArg">Argüman ipucu</label>', 'placeholder="[dosya yolu]"',
  '<label for="pArac">İzinli araçlar</label>', '<label for="pModel">Model</label>', '>Paket sayfasını aç</button>', "Claude Code'da çağır: <code>/plug:foo</code>",
  'aria-label="Prompt metni"', 'placeholder="Prompt metnini buraya yaz. {{degisken}} biçiminde yer tutucular kullanabilirsin."',
  'aria-label="x değerini kaldır"', 'placeholder="Etiket ekle, Enter"', 'placeholder="Hangi projelerde kullanılıyor?"', '<span class="pill ok">Yayında, güncel</span>'
];

const EDIT_EN = [
  '<label>Tags</label>', '<label for="fDurum2">Status</label>', '>Not set</option>', '>Draft</option>', '>Stable</option>', '>Archived</option>',
  '<label for="fVer">Version</label>', 'placeholder="No version yet (+1 creates 1.0.0)"', 'title="Create a new version: the version is bumped, and a commit and a tag are made"',
  '<label>Projects</label>', '<summary><b>Claude Code publishing settings</b>', '<label for="pTur">Type</label>', '>Not published</option>', '>Command (slash command)</option>',
  '>Agent (subagent)</option>', '>Skill</option>', '<label for="pPaket">Package</label>', '>Package: plug (from the folder)</span>', '<label for="pAd">Name</label>',
  '<label for="pAcik">Description</label>', 'placeholder="What does this prompt do? When should Claude use it?"', '<label for="pArg">Argument hint</label>', 'placeholder="[file path]"',
  '<label for="pArac">Allowed tools</label>', '<label for="pModel">Model</label>', '>Open package page</button>', 'Invoke in Claude Code: <code>/plug:foo</code>',
  'aria-label="Prompt text"', 'placeholder="Write the prompt text here. You can use placeholders in the {{variable}} format."',
  'aria-label="Remove x"', 'placeholder="Add a tag, Enter"', 'placeholder="Which projects is it used in?"', '<span class="pill ok">Published, up to date</span>'
];

test('editör paneli: tr bugünkü Türkçe, en İngilizce; aynı işlev tr-en-tr etiketleri bayatlatmaz', () => {
  const { ctx, g } = mainCtx(SAMPLE, { publish: { tur: 'komut', paket: 'plug', ad: 'foo', state: 'guncel', target: 'plugins/plug/commands/foo.md' } });
  const out = inLangs(g, () => ctx.editPaneHtml());
  for (const text of EDIT_TR) assert.ok(out.tr.includes(text), 'tr: ' + text + '\n' + out.tr);
  for (const text of EDIT_EN) assert.ok(out.en.includes(text), 'en: ' + text + '\n' + out.en);
  assert.doesNotMatch(out.en, /Etiketler|Belirsiz|Yayın dışı|Taslak/);
});

test('editör paneli: işaretleme iskeleti (id, data-f, option value) iki dilde aynı', () => {
  const { ctx, g } = mainCtx(SAMPLE, { publish: { tur: 'ajan', paket: 'plug', ad: 'foo', state: 'eski', target: 't' } });
  const out = inLangs(g, () => skeleton(ctx.editPaneHtml()));
  assert.equal(out.en, out.tr);
});

test('editör paneli: ajan kullanım ipucu, klasörsüz prompt için varsayılan paket yer tutucusu ve tanınmayan değerler', () => {
  const { ctx, g } = mainCtx('---\nbaslik: B\ntur: yanlis\ndurum: ilginc\n---\nx', { path: 'prompts/loose.md', publish: { tur: 'ajan', paket: 'plug', ad: 'foo', state: 'guncel' } });
  const out = inLangs(g, () => ctx.editPaneHtml());
  assert.ok(out.tr.includes('Ajan adı: <code>foo</code>') && out.en.includes('Agent name: <code>foo</code>'));
  assert.ok(out.tr.includes('placeholder="Varsayılan: varsayilan"') && out.en.includes('placeholder="Default: varsayilan"'));
  assert.ok(out.tr.includes('⚠ "yanlis" (tanınmadı)</option>') && out.en.includes('⚠ "yanlis" (not recognized)</option>'));
  for (const lang of ['tr', 'en']) assert.ok(out[lang].includes('<option value="ilginc" selected>ilginc</option>'), 'bilinmeyen durum ham: ' + lang);
});

test('kanonik değer: İngilizce arayüzde Stable ve Command seçimi dosyaya durum: kararlı ve tur: komut yazar', () => {
  const { ctx, g, S, c } = mainCtx('---\nbaslik: A\n---\ngövde');
  const setter = load({ fns: ['setField'], consts: ['str'] }, { ...g, S, leadOf: () => '', updateDirty() {}, refreshPubWarn() {}, paintPaketHint() {}, paintVerHint() {} });
  const pick = (lang, durumText, turText) => {
    g.I18n.setLanguage(lang);
    const markup = ctx.editPaneHtml();
    return { durum: optionValue(markup, 'fDurum2', durumText), tur: optionValue(markup, 'pTur', turText), durumValues: optionValues(markup, 'fDurum2'), turValues: optionValues(markup, 'pTur') };
  };
  const tr = pick('tr', 'Kararlı', 'Komut (slash command)');
  const en = pick('en', 'Stable', 'Command (slash command)');
  assert.deepEqual(en, tr, 'seçilen değerler ve option value kümeleri dilden bağımsız');
  assert.deepEqual(en.durumValues, ['', 'taslak', 'kararlı', 'arşiv']);
  assert.deepEqual(en.turValues, ['', 'komut', 'ajan', 'skill']);
  g.I18n.setLanguage('en');
  setter.setField('durum', en.durum);
  setter.setField('tur', en.tur);
  const written = FM.stringify(c.parsed);
  assert.match(written, /^durum: kararlı$/m);
  assert.match(written, /^tur: komut$/m);
  assert.doesNotMatch(written, /Stable|Command|Draft|Archived/);
});

test('XSS: editör alanları, etiket çipleri, değişken listesi ve ham metin iki dilde kaçışlanır', () => {
  const p = FM.parse('---\nbaslik: A\n---\ngövde ' + XSS + ' {{' + XSS + '}}');
  for (const key of ['versiyon', 'durum', 'tur', 'komut_adi', 'aciklama', 'paket', 'arguman_ipucu', 'izinli_araclar', 'model']) FM.set(p, key, XSS);
  FM.set(p, 'etiketler', [XSS]);
  FM.set(p, 'projeler', [XSS]);
  const { ctx, g, c } = mainCtx(SAMPLE, { path: 'prompts/loose.md', publish: { tur: 'komut', paket: XSS, ad: XSS, state: 'guncel' } });
  c.parsed = p;
  const out = inLangs(g, () => ctx.editPaneHtml() + ctx.bodyInfoText() + ctx.rawPaneHtml());
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(out[lang], /<img/, lang);
    assert.ok(out[lang].includes(XSS_ESCAPED), lang);
  }
  const chips = inLangs(g, () => ctx.chipsHtml('etiketler', [XSS], 'ph'));
  for (const lang of ['tr', 'en']) assert.doesNotMatch(chips[lang], /<img/, lang);
  assert.ok(chips.tr.includes('aria-label="' + XSS_ESCAPED + ' değerini kaldır"'));
  assert.ok(chips.en.includes('aria-label="Remove ' + XSS_ESCAPED + '"'));
});

test('yayın rozeti: beş durum iki dilde ve rozet sınıfları sabit', () => {
  const { ctx, g, c } = mainCtx(SAMPLE);
  const states = [
    ['yayında güncel', { state: 'guncel' }, 'pill ok', 'Yayında, güncel', 'Published, up to date'],
    ['kaynak değişti', { state: 'eski' }, 'pill warn', 'Yayında, kaynak değişti', 'Published, source changed'],
    ['henüz yayınlanmadı', { state: 'yok' }, 'pill warn', 'Henüz yayınlanmadı', 'Not published yet'],
    ['kaydedince', null, 'pill warn', 'Kaydedince yayınlanabilir', 'Can be published once saved']
  ];
  for (const [ad, publish, cls, wantTr, wantEn] of states) {
    c.publish = publish;
    const out = inLangs(g, () => ctx.pubPill());
    assert.equal(out.tr, '<span class="' + cls + '">' + wantTr + '</span>', ad);
    assert.equal(out.en, '<span class="' + cls + '">' + wantEn + '</span>', ad);
  }
  c.parsed = FM.parse('---\nbaslik: C\n---\nx');
  const off = inLangs(g, () => ctx.pubPill());
  assert.equal(off.tr, '<span class="pill">Yayın dışı</span>');
  assert.equal(off.en, '<span class="pill">Not published</span>');
  c.parsed = FM.parse('---\nbaslik: C\ntur: yanlis\n---\nx');
  const warn = inLangs(g, () => ctx.pubPill());
  assert.equal(warn.tr, '<span class="pill warn">Yayınlanmayacak</span>');
  assert.equal(warn.en, '<span class="pill warn">Will not be published</span>');
});

test('gövde bilgisi: kelime ve karakter sayısı çoğul, değişken listesi ve kaydedilmemiş notu dile göre', () => {
  const { ctx, g, c } = mainCtx(SAMPLE);
  const counts = (markup) => /^<span>([^<]*)<\/span>/.exec(markup)[1];
  const cases = [
    ['a', '1 kelime, 1 karakter', '1 word, 1 character'],
    ['a b c', '3 kelime, 5 karakter', '3 words, 5 characters'],
    ['', '0 kelime, 0 karakter', '0 words, 0 characters']
  ];
  for (const [body, wantTr, wantEn] of cases) {
    c.parsed.body = body;
    const out = inLangs(g, () => counts(ctx.bodyInfoText()));
    assert.equal(out.tr, wantTr);
    assert.equal(out.en, wantEn);
  }
  c.parsed.body = 'metin {{ad}} ve {{<b>}}';
  c.dirty = true;
  const out = inLangs(g, () => ctx.bodyInfoText());
  assert.ok(out.tr.includes('<span>Değişkenler: <code>ad</code> <code>&lt;b&gt;</code></span>'), out.tr);
  assert.ok(out.en.includes('<span>Variables: <code>ad</code> <code>&lt;b&gt;</code></span>'), out.en);
  assert.ok(out.tr.endsWith('<span id="dirtyNote" >Kaydedilmemiş değişiklik var</span>'), out.tr);
  assert.ok(out.en.endsWith('<span id="dirtyNote" >There are unsaved changes</span>'), out.en);
  const raw = inLangs(g, () => ctx.rawPaneHtml());
  assert.ok(raw.tr.includes('aria-label="Dosya içeriği"') && raw.tr.includes('<span>Tüm dosya, frontmatter dahil. Biçimi bozmadan düzenle.</span>'));
  assert.ok(raw.en.includes('aria-label="File content"') && raw.en.includes('<span>The whole file, including the frontmatter. Edit without breaking the format.</span>'));
});

test('ana alan çerçevesi: sekmeler, düğmeler, commit çubuğu ve bantlar dile göre; sekme kimlikleri sabit', () => {
  const { ctx, g, dom, c } = mainCtx(SAMPLE, { mp: 'baska', generatedFrom: 'prompts/src.md', external: true, restoredFrom: { source: 'version', version: '2.0.0' }, commitMsg: 'm' });
  const render = () => { ctx.renderMainInner(); return dom.els['#main'].innerHTML; };
  const out = inLangs(g, render);
  const tabs = (markup) => [...markup.matchAll(/data-tab="([^"]+)">([^<]*)</g)].map((m) => m[1] + '=' + m[2]);
  assert.deepEqual(tabs(out.tr), ['edit=Düzenle', 'raw=Ham metin', 'hist=Geçmiş']);
  assert.deepEqual(tabs(out.en), ['edit=Edit', 'raw=Raw text', 'hist=History']);
  const trWant = [
    'title="Ağaçta göster">baska</button>', 'aria-label="Başlık"', '<button class="btn" data-act="copy" title="Prompt metnini panoya kopyala">Kopyala</button>',
    '<label for="commitMsg" class="hint">Commit mesajı (baska)</label>', 'placeholder="Ne değişti, neden? (boşsa yalnızca kaydedilir)"', '>Commit bekliyor</span>',
    "<div class=\"banner\" role=\"alert\">Bu dosya <b>baska</b> marketplace'ine ait ama etkin marketplace şu an <b>mp</b>. Kaydetmek için dosyayı ağaçtan yeniden aç.</div>",
    '<div class="banner">Bu dosya <b>prompts/src.md</b> kaynağından otomatik üretildi. Burada yaptığın değişiklik bir sonraki yayında ezilir.<button class="btn sm" data-act="open" data-path="prompts/src.md">Kaynağa git</button></div>',
    '<div class="banner">Bu dosya, sen açtıktan sonra diskte değişti. Kaydedersen ne yapmak istediğini soracağım.</div>',
    '<span class="restorebar">Editörde v2.0.0 sürümünün içeriği var (kaydedilmedi). Kaydedersen dosya bu içerikle değişir.<button class="btn sm" data-act="ver-restore-cancel">Geri al</button></span>'
  ];
  const enWant = [
    'title="Show in tree">baska</button>', 'aria-label="Title"', '<button class="btn" data-act="copy" title="Copy the prompt text to the clipboard">Copy</button>',
    '<label for="commitMsg" class="hint">Commit message (baska)</label>', 'placeholder="What changed and why? (if empty, it is only saved)"', '>Commit pending</span>',
    '<div class="banner" role="alert">This file belongs to the <b>baska</b> marketplace but the active marketplace is currently <b>mp</b>. Reopen the file from the tree to save.</div>',
    '<div class="banner">This file was generated automatically from <b>prompts/src.md</b>. Changes you make here are overwritten on the next publish.<button class="btn sm" data-act="open" data-path="prompts/src.md">Go to source</button></div>',
    '<div class="banner">This file changed on disk after you opened it. If you save, I will ask what you want to do.</div>',
    '<span class="restorebar">The editor contains the content of v2.0.0 (not saved). If you save, the file will be replaced with this content.<button class="btn sm" data-act="ver-restore-cancel">Undo</button></span>'
  ];
  for (const text of trWant) assert.ok(out.tr.includes(text), 'tr: ' + text);
  for (const text of enWant) assert.ok(out.en.includes(text), 'en: ' + text);
  c.restoredFrom = { source: 'commit', short: 'abc1234' };
  c.mp = 'mp';
  c.generatedFrom = null;
  c.external = false;
  const commit = inLangs(g, render);
  assert.ok(commit.tr.includes("Editörde abc1234 commit'inin içeriği var (kaydedilmedi)."), commit.tr);
  assert.ok(commit.en.includes('The editor contains the content of commit abc1234 (not saved).'), commit.en);
  assert.equal(skeleton(commit.en), skeleton(commit.tr));
});

test('ana alan çerçevesi: prompt olmayan dosya sekmeleri ve etkin marketplace yokken banner, kullanıcı metni kaçışlı', () => {
  const { ctx, g, dom, S } = mainCtx(SAMPLE, { isPrompt: false, tab: 'raw', mp: XSS, path: 'README.md', generatedFrom: XSS, restoredFrom: { source: 'version', version: XSS } });
  S.info.activeMarketplace = '';
  const out = inLangs(g, () => { ctx.renderMainInner(); return dom.els['#main'].innerHTML; });
  const tabs = (markup) => [...markup.matchAll(/data-tab="([^"]+)">([^<]*)</g)].map((m) => m[1] + '=' + m[2]);
  assert.deepEqual(tabs(out.tr), ['raw=Düzenle', 'hist=Geçmiş']);
  assert.deepEqual(tabs(out.en), ['raw=Edit', 'hist=History']);
  assert.ok(out.tr.includes('etkin marketplace şu an <b>yok</b>.') && out.en.includes('active marketplace is currently <b>none</b>.'));
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(out[lang], /<img/, lang);
    assert.ok(out[lang].includes('<b>' + XSS_ESCAPED + '</b>'), lang);
  }
});

test('başlangıç ekranı: boş, tek prompt ve çok prompt çoğulları; son değişenler kaçışlı', () => {
  const { ctx, g, S } = mainCtx(SAMPLE);
  S.cur = null;
  S.facets.total = 7;
  S.recent = [{ mp: 'm', path: 'p/x.md', baslik: XSS, durum: 'taslak' }];
  const many = inLangs(g, () => ctx.startHtml());
  assert.ok(many.tr.includes('<h1>Bir prompt seç</h1>') && many.en.includes('<h1>Select a prompt</h1>'));
  assert.ok(many.tr.includes('<p>Havuzunda 7 prompt var. Soldaki listeden veya arama kutusundan birini aç. Sık kopyaladıklarını etiketle, değiştirdiklerini git ile kaydet.</p>'));
  assert.ok(many.en.includes('<p>Your library has 7 prompts. Open one from the list on the left or from the search box.'));
  assert.ok(many.tr.includes('<h2>Son değişenler</h2>') && many.en.includes('<h2>Recent changes</h2>'));
  assert.ok(many.tr.includes('>Yeni prompt</button><button class="btn" data-act="import">.txt dosyalarını içe aktar</button>'));
  assert.ok(many.en.includes('>New prompt</button><button class="btn" data-act="import">Import .txt files</button>'));
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(many[lang], /<img/, lang);
    assert.ok(many[lang].includes(XSS_ESCAPED), lang);
  }
  S.facets.total = 1;
  S.recent = [];
  const one = inLangs(g, () => ctx.startHtml());
  assert.ok(one.tr.includes('Havuzunda 1 prompt var.') && one.en.includes('Your library has 1 prompt. Open it from'));
  S.facets.total = 0;
  const none = inLangs(g, () => ctx.startHtml());
  assert.ok(none.tr.includes('<h1>Havuz henüz boş</h1>') && none.tr.includes('Eski .txt dosyalarını içe aktararak başlayabilir ya da sıfırdan yeni bir prompt yazabilirsin.'));
  assert.ok(none.en.includes('<h1>The library is still empty</h1>') && none.en.includes('You can start by importing your old .txt files or by writing a new prompt from scratch.'));
});

test('ekmek kırıntısı: gelen kutusu ve klasörsüz etiketleri dile göre, dosya adı kaçışlı', () => {
  const { ctx, g, c } = mainCtx(SAMPLE);
  const crumbs = (p) => { c.path = p; return inLangs(g, () => ctx.crumbsHtml(c)); };
  const sep = '<span class="sep">›</span>';
  const inbox = crumbs('prompts/gelen-kutusu/z.md');
  assert.ok(inbox.tr.endsWith(sep + 'Gelen kutusu' + sep + 'z.md'), inbox.tr);
  assert.ok(inbox.en.endsWith(sep + 'Inbox' + sep + 'z.md'), inbox.en);
  const loose = crumbs('prompts/' + XSS + '.md');
  assert.ok(loose.tr.endsWith(sep + 'Klasörsüz' + sep + XSS_ESCAPED + '.md'), loose.tr);
  assert.ok(loose.en.endsWith(sep + 'No folder' + sep + XSS_ESCAPED + '.md'), loose.en);
  assert.doesNotMatch(loose.tr + loose.en, /<img/);
});

/** Summary: Sürüm geçmişi örnek verisi (iki sürüm: yeni ve yeniden adlandırılmış eski). */
function versionFixture() {
  const versions = [
    { tag: 'prompt/a/v2.0.0', version: '2.0.0', date: DATE_ISO, subject: 'S2 ' + XSS, short: 'abc1234', tagger: 'Kaan', note: 'Not ' + XSS, annotated: true, pathAtTag: 'prompts/a.md', renamed: false },
    { tag: 'prompt/a/v1.0.0', version: '1.0.0', date: DATE_ISO, subject: '', short: 'def5678', tagger: '', note: '', annotated: false, pathAtTag: 'prompts/' + XSS + '.md', renamed: true }
  ];
  return { data: { tracked: true, versions, ignoredTags: 2 }, sel: versions[0].tag, a: versions[1].tag, b: versions[0].tag, view: null, cmp: null, cache: {} };
}

test('sürüm zaman çizelgesi ve kartı: rozetler, notsuz sürüm, imzalayan ve tarih dile göre; kullanıcı metni kaçışlı', () => {
  const { ctx, g } = mainCtx(SAMPLE);
  const ver = versionFixture();
  const out = inLangs(g, () => ({
    timeline: ctx.verTimelineHtml(ver), card0: ctx.verCardHtml(ver, ver.data.versions[0]), card1: ctx.verCardHtml(ver, ver.data.versions[1]), date: ctx.fmtDate(DATE_ISO)
  }));
  assert.equal(out.tr.date, new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(DATE_ISO)));
  assert.equal(out.en.date, new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(DATE_ISO)));
  assert.notEqual(out.tr.date, out.en.date);
  assert.ok(out.tr.timeline.includes('<span class="pill ok">Son sürüm</span>') && out.en.timeline.includes('<span class="pill ok">Latest version</span>'));
  assert.ok(out.tr.timeline.includes('<span class="pill">Eski ad: ' + XSS_ESCAPED + '.md</span>') && out.en.timeline.includes('<span class="pill">Old name: ' + XSS_ESCAPED + '.md</span>'));
  assert.ok(out.tr.timeline.includes('<span class="pill">Notsuz</span>') && out.en.timeline.includes('<span class="pill">No note</span>'));
  assert.ok(out.tr.timeline.includes(out.tr.date) && out.en.timeline.includes(out.en.date));
  assert.ok(out.tr.card0.includes('Sürümü oluşturan: Kaan, commit abc1234') && out.en.card0.includes('Created by: Kaan, commit abc1234'));
  assert.ok(out.tr.card1.includes('<div class="hint">commit def5678</div>') && out.en.card1.includes('<div class="hint">commit def5678</div>'));
  assert.ok(out.tr.card1.includes('Bu sürümde not yok.') && out.en.card1.includes('This version has no note.'));
  assert.ok(out.tr.card0.includes('>Görüntüle</button><button class="btn sm" data-act="ver-load" data-tag="prompt/a/v2.0.0">Bu sürümü editöre al</button><button class="btn sm" data-act="ver-prev" data-tag="prompt/a/v2.0.0">Bir öncekiyle karşılaştır</button>'));
  assert.ok(out.en.card0.includes('>View</button><button class="btn sm" data-act="ver-load" data-tag="prompt/a/v2.0.0">Load this version into the editor</button><button class="btn sm" data-act="ver-prev" data-tag="prompt/a/v2.0.0">Compare with the previous one</button>'));
  assert.ok(!out.tr.card1.includes('ver-prev'), 'ilk sürümde karşılaştırma düğmesi yok');
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(out[lang].timeline + out[lang].card0 + out[lang].card1, /<img/, lang);
    assert.ok(out[lang].card0.includes(XSS_ESCAPED), lang);
  }
});

test('sürüm görünümü ve sürüm seçicileri: yükleniyor, hata, salt okunur başlık, Eski/Yeni etiketleri ve (eski ad) seçeneği', () => {
  const { ctx, g, c } = mainCtx(SAMPLE, { tab: 'hist' });
  const ver = versionFixture();
  c.hist = { mode: 'ver', ver, commit: null };
  ver.view = { loading: true };
  const loading = inLangs(g, () => ctx.verViewHtml(ver));
  assert.equal(loading.tr, '<p class="hint">Sürüm yükleniyor…</p>');
  assert.equal(loading.en, '<p class="hint">Loading version…</p>');
  ver.view = { error: 'Sunucu iletisi ' + XSS };
  const failed = inLangs(g, () => ctx.verViewHtml(ver));
  assert.ok(failed.tr.endsWith('<button class="btn sm" data-act="ver-view-close">Kapat</button></p>') && failed.en.endsWith('<button class="btn sm" data-act="ver-view-close">Close</button></p>'));
  assert.ok(failed.tr.includes('Sunucu iletisi ' + XSS_ESCAPED) && failed.en.includes('Sunucu iletisi ' + XSS_ESCAPED), 'sunucu iletisi ham ama kaçışlı');
  ver.view = { tag: ver.sel, version: '2.0.0', date: DATE_ISO, raw: '---\nbaslik: X\n---\nsatır ' + XSS + '\n' };
  const view = inLangs(g, () => ({ markup: ctx.verViewHtml(ver), date: ctx.fmtDate(DATE_ISO) }));
  assert.ok(view.tr.markup.includes('<span class="hint">(' + view.tr.date + '), salt okunur</span>') && view.en.markup.includes('<span class="hint">(' + view.en.date + '), read-only</span>'));
  assert.ok(view.tr.markup.includes('aria-label="Sürümün içeriği"') && view.en.markup.includes('aria-label="Version content"'));
  assert.ok(view.tr.markup.includes('Bu sürümü editöre al') && view.en.markup.includes('Load this version into the editor'));
  assert.doesNotMatch(view.tr.markup + view.en.markup, /<img/);
  ver.view = null;
  const pane = inLangs(g, () => ctx.histVerHtml(c.hist));
  assert.ok(pane.tr.includes('<label>Eski <select id="verA">') && pane.tr.includes('<label>Yeni <select id="verB">'));
  assert.ok(pane.en.includes('<label>Older <select id="verA">') && pane.en.includes('<label>Newer <select id="verB">'));
  assert.ok(pane.tr.includes('>Son commit</option>') && pane.en.includes('>Last commit</option>'));
  assert.ok(pane.tr.includes('>v1.0.0 (eski ad)</option>') && pane.en.includes('>v1.0.0 (old name)</option>'));
  assert.ok(pane.tr.includes('aria-label="Sürüm zaman çizelgesi"') && pane.en.includes('aria-label="Version timeline"'));
  assert.equal(skeleton(pane.en), skeleton(pane.tr));
  const modes = inLangs(g, () => ctx.histPaneHtml());
  assert.ok(modes.tr.includes('aria-label="Geçmiş görünümü">') && modes.en.includes('aria-label="History view">'));
  assert.ok(modes.tr.includes('data-mode="ver" aria-pressed="true">Sürümler</button>') && modes.en.includes('data-mode="ver" aria-pressed="true">Versions</button>'));
  assert.ok(modes.tr.includes("data-mode=\"commit\" aria-pressed=\"false\">Commit'ler</button>") && modes.en.includes('data-mode="commit" aria-pressed="false">Commits</button>'));
});

test('geçmiş panosu: yükleniyor, eskimiş dosya, git deposu yok, hata ve kayıtsız sürüm durumları dile göre', () => {
  const { ctx, g, c, S } = mainCtx(SAMPLE, { tab: 'hist', mp: 'baska' });
  const pane = (hist) => { c.hist = hist; return inLangs(g, () => ctx.histPaneHtml()); };
  const loading = pane({ loading: true });
  assert.equal(loading.tr, '<p class="hint">Geçmiş yükleniyor…</p>');
  assert.equal(loading.en, '<p class="hint">Loading history…</p>');
  const stale = pane({ stale: true });
  assert.equal(stale.tr, "<p class=\"issue warn\">Bu dosya baska marketplace'ine ait ama etkin marketplace mp. Geçmişi görmek için dosyayı ağaçtan yeniden aç.</p>");
  assert.equal(stale.en, '<p class="issue warn">This file belongs to the baska marketplace but the active marketplace is mp. Reopen the file from the tree to see its history.</p>');
  c.mp = XSS;
  S.info.activeMarketplace = '';
  const staleNone = inLangs(g, () => ctx.histPaneHtml());
  assert.ok(staleNone.tr.endsWith('etkin marketplace yok. Geçmişi görmek için dosyayı ağaçtan yeniden aç.</p>'), staleNone.tr);
  assert.ok(staleNone.en.endsWith('the active marketplace is none. Reopen the file from the tree to see its history.</p>'), staleNone.en);
  assert.doesNotMatch(staleNone.tr + staleNone.en, /<img/);
  assert.ok(staleNone.tr.includes(XSS_ESCAPED) && staleNone.en.includes(XSS_ESCAPED));
  c.mp = 'mp';
  S.info.activeMarketplace = 'mp';
  const norepo = pane({ noRepo: true });
  assert.equal(norepo.tr, '<p>Geçmiş kaydı için havuzun bir git deposu olması gerekir.</p><p><button class="btn primary" data-act="git">Git panelini aç</button></p>');
  assert.equal(norepo.en, '<p>History tracking requires the library to be a git repository.</p><p><button class="btn primary" data-act="git">Open Git panel</button></p>');
  const failed = pane({ error: 'Sunucu: ' + XSS });
  assert.equal(failed.tr, failed.en, 'sunucu iletisi çevrilmeden ham');
  assert.doesNotMatch(failed.tr, /<img/);
  const ver = versionFixture();
  const states = [
    [{ tracked: false, versions: [], ignoredTags: 0 },
      "<p class=\"hint\">Bu dosya henüz commit edilmedi. Sürüm geçmişi ilk commit'ten sonra oluşur.</p><p class=\"hint\">Dosya taşındıysa, eski ve yeni yolu birlikte commit edersen geçmiş bağlanır.</p>",
      '<p class="hint">This file has not been committed yet. The version history is created after the first commit.</p><p class="hint">If the file was moved, the history is linked once you commit the old and new paths together.</p>'],
    [{ tracked: true, versions: [], ignoredTags: 1 },
      "<p class=\"hint\">Bu prompt için henüz sürüm yok. Sürüm, Düzenle sekmesindeki +1 düğmesiyle oluşturulur.</p><p><button class=\"btn\" data-act=\"hist-mode\" data-mode=\"commit\">Commit'leri göster</button></p><p class=\"issue info\">1 tag sürüm biçimine uymadığı için atlandı.</p>",
      '<p class="hint">This prompt has no versions yet. A version is created with the +1 button on the Edit tab.</p><p><button class="btn" data-act="hist-mode" data-mode="commit">Show commits</button></p><p class="issue info">1 tag was skipped because it does not match the version format.</p>'],
    [{ tracked: true, versions: [], ignoredTags: 2 }, null, '<p class="issue info">2 tags were skipped because they do not match the version format.</p>']
  ];
  for (const [data, wantTr, wantEn] of states) {
    ver.data = data;
    const out = pane({ mode: 'ver', ver, commit: null });
    const body = (text) => text.replace(/^<div class="seg"[\s\S]*?<\/div>/, '');
    if (wantTr) assert.equal(body(out.tr), wantTr);
    assert.ok(body(out.en).includes(wantEn), out.en);
  }
});

test('commit görünümü: çalışma kopyası satırı, kayıtsız dosya, commit yok ve seçim ipucu dile göre', () => {
  const { ctx, g, c } = mainCtx(SAMPLE, { tab: 'hist' });
  const commit = { hash: 'b'.repeat(40), subject: 'Konu ' + XSS, date: DATE_ISO, short: 'bbbbbbb', author: 'A' };
  const cm = { commits: [commit], working: { diff: 'x', untracked: false }, sel: 'working', diffs: {} };
  const view = (state) => { c.hist = { mode: 'commit', ver: null, commit: state }; return inLangs(g, () => ctx.histPaneHtml()); };
  const full = view(cm);
  assert.ok(full.tr.includes('<div class="s">Commit edilmemiş değişiklikler</div><div class="hint">Son commit ile fark</div>'));
  assert.ok(full.en.includes('<div class="s">Uncommitted changes</div><div class="hint">Difference from the last commit</div>'));
  assert.ok(full.tr.includes('<pre class="diff" id="diffBox">Bir kayıt seç.</pre>') && full.en.includes('<pre class="diff" id="diffBox">Select an entry.</pre>'));
  assert.doesNotMatch(full.tr + full.en, /<img/);
  assert.ok(full.tr.includes(XSS_ESCAPED) && full.en.includes(XSS_ESCAPED));
  cm.working = { diff: '', untracked: true };
  const untracked = view(cm);
  assert.ok(untracked.tr.includes("<div class=\"hint\">Dosya henüz git'e eklenmedi</div>"));
  assert.ok(untracked.en.includes('<div class="hint">The file has not been added to git yet</div>'));
  cm.working = null;
  cm.commits = [];
  const empty = view(cm);
  assert.equal(empty.tr, '<p class="hint">Bu dosya için henüz commit yok. Kaydederken commit mesajı yazarsan commit edilir.</p>');
  assert.equal(empty.en, '<p class="hint">There are no commits for this file yet. If you write a commit message when saving, it is committed.</p>');
  const loading = view(null);
  assert.equal(loading.tr, '<p class="hint">Geçmiş yükleniyor…</p>');
  assert.equal(loading.en, '<p class="hint">Loading history…</p>');
});

/** Summary: Sürüm karşılaştırma verisi (yeniden adlandırma, çeşitli alan türleri, kelime farkı, kısaltılmış commit listesi). */
function compareFixture(ver) {
  const [v2, v1] = ver.data.versions;
  return {
    a: { ref: v1.tag, version: '1.0.0', pathAtRef: 'prompts/eski.md' },
    b: { ref: v2.tag, version: '2.0.0', pathAtRef: 'prompts/' + XSS + '.md' },
    renamed: true,
    fmBroken: { a: false, b: false },
    fields: [
      { key: 'baslik', from: 'Eski', to: XSS },
      { key: 'etiketler', list: true, from: ['a', 'b'], to: ['b', 'c'], removed: ['a'], added: ['c'] },
      { key: 'projeler', list: true, kind: 'sira', from: ['a', 'b'], to: ['b', 'a'], removed: [], added: [] },
      { key: 'komut_adi', from: 'a', to: null },
      { key: 'izinli_araclar', from: '1', to: '2' },
      { key: 'bilinmeyen_anahtar', from: null, to: 'x' },
      { key: 'constructor', from: 'a', to: 'b' }
    ],
    body: { same: false, truncated: true, hunks: [{ newStart: 4, lines: [[{ t: '=', s: 'aynı ' }, { t: '-', s: 'eski ' + XSS }, { t: '+', s: 'yeni' }], []] }] },
    commits: [{ hash: 'a'.repeat(40), subject: 'Konu ' + XSS, date: DATE_ISO, short: 'aaaaaaa', path: 'p.md' }],
    commitsTruncated: true
  };
}

test('sürüm karşılaştırma: alan tablosu etiketleri, silinen/eklenen okuyucu metni, kelime farkı ve ek notlar dile göre', () => {
  const { ctx, g } = mainCtx(SAMPLE, { tab: 'hist' });
  const ver = versionFixture();
  ver.cmp = { data: compareFixture(ver) };
  const out = inLangs(g, () => ctx.verCompareHtml(ver));
  const heads = (markup) => [...markup.matchAll(/<th scope="row">(.*?)<\/th>/g)].map((m) => m[1].replace(/<\/?code>/g, '`'));
  assert.deepEqual(heads(out.tr), ['Başlık', 'Etiketler', 'Projeler', 'Ad', 'İzinli araçlar', '`bilinmeyen_anahtar`', '`constructor`']);
  assert.deepEqual(heads(out.en), ['Title', 'Tags', 'Projects', 'Name', 'Allowed tools', '`bilinmeyen_anahtar`', '`constructor`']);
  assert.ok(out.tr.includes('<caption>Frontmatter alanları</caption><thead><tr><th scope="col">Alan</th><th scope="col">v1.0.0</th><th scope="col">v2.0.0</th>'));
  assert.ok(out.en.includes('<caption>Frontmatter fields</caption><thead><tr><th scope="col">Field</th><th scope="col">v1.0.0</th><th scope="col">v2.0.0</th>'));
  assert.ok(out.tr.includes('<span class="sr">silinen: </span>' + MINUS + 'a') && out.tr.includes('<span class="sr">eklenen: </span>+c'));
  assert.ok(out.en.includes('<span class="sr">removed: </span>' + MINUS + 'a') && out.en.includes('<span class="sr">added: </span>+c'));
  assert.ok(out.tr.includes('<div class="hint">Yalnızca sıra değişti</div>') && out.en.includes('<div class="hint">Only the order changed</div>'));
  assert.ok(out.tr.includes('<span class="dl hunk">@@ satır 4 @@</span>') && out.en.includes('<span class="dl hunk">@@ line 4 @@</span>'));
  assert.ok(out.tr.includes('<del class="wd"><span class="sr">silinen: </span>eski ' + XSS_ESCAPED + '</del>'));
  assert.ok(out.en.includes('<ins class="wd"><span class="sr">added: </span>yeni</ins>'));
  assert.ok(out.tr.includes('Dosya bu aralıkta yeniden adlandırıldı: prompts/eski.md → prompts/' + XSS_ESCAPED + '.md'));
  assert.ok(out.en.includes('The file was renamed in this range: prompts/eski.md → prompts/' + XSS_ESCAPED + '.md'));
  assert.ok(out.tr.includes("<summary>Bu aralıktaki commit'ler (1+)</summary>") && out.en.includes('<summary>Commits in this range (1+)</summary>'));
  assert.ok(out.tr.includes('<p class="hint">Fark çok büyük, kısaltıldı.</p>') && out.en.includes('<p class="hint">The difference is too large and was truncated.</p>'));
  assert.ok(out.tr.includes('aria-label="Gövde farkı"') && out.en.includes('aria-label="Body difference"'));
  assert.ok(out.tr.endsWith('<p class="hint">Kaydedilmemiş ve commit edilmemiş değişiklikler karşılaştırmaya dahil değildir.</p>'));
  assert.ok(out.en.endsWith('<p class="hint">Unsaved and uncommitted changes are not included in the comparison.</p>'));
  for (const lang of ['tr', 'en']) {
    assert.doesNotMatch(out[lang], /<img/, lang);
    assert.ok(out[lang].includes(XSS_ESCAPED), lang);
  }
  assert.equal(skeleton(out.en), skeleton(out.tr));
});

test('sürüm karşılaştırma: aynı seçim, yükleniyor, ayniSurum kodu, sunucu hatası, bozuk frontmatter ve değişiklik yok durumları', () => {
  const { ctx, g } = mainCtx(SAMPLE, { tab: 'hist' });
  const ver = versionFixture();
  const data = compareFixture(ver);
  const at = (patch) => { Object.assign(ver, patch); return inLangs(g, () => ctx.verCompareHtml(ver)); };
  const same = at({ a: ver.b });
  assert.equal(same.tr, '<p class="hint">Karşılaştırılacak önceki sürüm yok (ilk sürüm) ya da iki seçim aynı. Farklı iki sürüm seç.</p>');
  assert.equal(same.en, '<p class="hint">There is no earlier version to compare (this is the first version) or both selections are the same. Select two different versions.</p>');
  ver.a = ver.data.versions[1].tag;
  const loading = at({ cmp: { loading: true } });
  assert.equal(loading.tr, '<p class="hint">Fark yükleniyor…</p>');
  assert.equal(loading.en, '<p class="hint">Loading difference…</p>');
  const sameCode = at({ cmp: { error: 'Sunucu iletisi', code: 'ayniSurum' } });
  assert.equal(sameCode.tr, '<p class="issue info">Karşılaştırılacak fark yok: seçilen iki sürüm aynı içeriğe işaret ediyor.</p>');
  assert.equal(sameCode.en, '<p class="issue info">There is no difference to compare: the two selected versions point to the same content.</p>');
  const server = at({ cmp: { error: 'Sunucu iletisi', code: 'baska' } });
  assert.equal(server.tr, '<p class="issue error">Sunucu iletisi</p>');
  assert.equal(server.en, server.tr, 'sunucu iletisi çevrilmeden ham');
  data.fmBroken = { a: true, b: true };
  const broken = at({ cmp: { data } });
  assert.ok(broken.tr.includes('<p class="issue warn">v1.0.0 sürümünde frontmatter kapanmamış; alanlar karşılaştırılamadı.</p><p class="issue warn">v2.0.0 sürümünde frontmatter kapanmamış; alanlar karşılaştırılamadı.</p>'));
  assert.ok(broken.en.includes('<p class="issue warn">In v1.0.0, the frontmatter is not closed; the fields could not be compared.</p><p class="issue warn">In v2.0.0, the frontmatter is not closed; the fields could not be compared.</p>'));
  Object.assign(data, { fmBroken: { a: false, b: false }, fields: [], body: { same: true }, commits: [], renamed: false });
  const empty = at({ cmp: { data } });
  assert.ok(empty.tr.includes('<p class="hint">Frontmatter alanlarında değişiklik yok.</p><p class="hint">Gövdede değişiklik yok.</p>'));
  assert.ok(empty.en.includes('<p class="hint">No changes in the frontmatter fields.</p><p class="hint">No changes in the body.</p>'));
  ver.data.versions = [ver.data.versions[0]];
  Object.assign(ver, { b: 'HEAD', a: ver.data.versions[0].tag });
  Object.assign(data, { a: { ref: ver.a, version: '2.0.0', pathAtRef: 'x' }, b: { ref: 'HEAD', version: null, pathAtRef: 'x' }, fields: [{ key: 'baslik', from: 'a', to: 'b' }] });
  const single = at({ cmp: { data } });
  assert.ok(single.tr.includes('Karşılaştırmak için ikinci bir sürüm yok; tek sürüm son commit ile karşılaştırılıyor.'));
  assert.ok(single.en.includes('There is no second version to compare; the only version is compared with the last commit.'));
  assert.ok(single.tr.includes('<th scope="col">v2.0.0</th><th scope="col">Son commit</th>') && single.en.includes('<th scope="col">v2.0.0</th><th scope="col">Last commit</th>'));
});

test('etiket tabloları: fieldLabel ve verLabel dil değişince bayatlamaz; bilinmeyen ve prototip anahtarları boş döner', () => {
  const { ctx, g } = mainCtx(SAMPLE);
  const keys = ['baslik', 'etiketler', 'projeler', 'durum', 'versiyon', 'olusturma', 'tur', 'paket', 'komut_adi', 'aciklama', 'arguman_ipucu', 'izinli_araclar', 'model'];
  const out = inLangs(g, () => plain(keys.map((k) => ctx.fieldLabel(k))));
  assert.deepEqual(out.tr, ['Başlık', 'Etiketler', 'Projeler', 'Durum', 'Versiyon', 'Oluşturma', 'Tür', 'Paket', 'Ad', 'Açıklama', 'Argüman ipucu', 'İzinli araçlar', 'Model']);
  assert.deepEqual(out.en, ['Title', 'Tags', 'Projects', 'Status', 'Version', 'Created', 'Type', 'Package', 'Name', 'Description', 'Argument hint', 'Allowed tools', 'Model']);
  const unknown = inLangs(g, () => plain(['bilinmeyen', 'constructor', '__proto__', 'toString', ''].map((k) => ctx.fieldLabel(k))));
  assert.deepEqual(unknown.tr, ['', '', '', '', '']);
  const labels = inLangs(g, () => plain([ctx.verLabel('HEAD', null), ctx.verLabel('prompt/a/v1.0.0', '1.0.0')]));
  assert.deepEqual(labels.tr, ['Son commit', 'v1.0.0']);
  assert.deepEqual(labels.en, ['Last commit', 'v1.0.0']);
});

/** Summary: Kaydet, commit, sürüm +1, kimlik, kopyalama ve eski içerik akışlarının yüklü olduğu, çağrıları kaydeden vm bağlamı. */
function flowCtx(raw = SAMPLE, curExtra = {}, overrides = {}) {
  const g = browserEnv();
  const log = { toasts: [], modals: [], choices: [] };
  const c = makeCur(raw, curExtra);
  const S = { info: { activeMarketplace: 'mp', config: { marketplace: { plugin: 'varsayilan' }, export: null } }, cur: c, git: { isRepo: true, files: [], identity: {} }, gen: 0 };
  const env = { choice: 'cancel', api: async () => ({}), get: async () => ({}), copyOk: true, ...overrides };
  const ctx = load({
    fns: ['confirmTurRemoval', 'askIdentity', 'commitOnly', 'openBump', 'save', 'copyBody', 'loadRawIntoEditor', 'loadVersionIntoEditor', 'loadOldVersion', 'errText'],
    consts: ['esc', 'str', 'fold', 'base', 'fmtDate'],
    expose: ['fmtDate']
  }, {
    ...g, S, $: () => null, document: { activeElement: null }, qs: (o) => Object.keys(o).map((k) => k + '=' + o[k]).join('&'),
    staleGuard: () => false, syncFromDom() {}, uncommitted: () => false, updateDirty() {}, afterWrite: async () => {}, leadOf: () => '', renderMain() {}, paintVerWarn() {}, isDirty: () => !!c.dirty,
    toast: (m, k) => log.toasts.push(k ? [m, k] : [m]), fail() {}, closeModal() {}, ls: { get: (k, d) => d, set() {} },
    openModal: (o) => log.modals.push({ title: o.title, html: o.html }), loadGit: async () => ({}),
    askChoice: async (o) => { log.choices.push(plain(o)); return env.choice; }, api: (...a) => env.api(...a), get: (...a) => env.get(...a),
    copyText: async () => env.copyOk, openFile: async () => {}
  });
  return { ctx, g, log, S, c, env };
}

test('tür kaldırma onayı: başlık, metin (yayında olan ve olmayan tam cümle) ve düğmeler dile göre; kimlikler sabit', async () => {
  const { ctx, g, log, c } = flowCtx();
  c.parsed = FM.parse(SAMPLE.replace('tur: komut\n', ''));
  const results = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    c.publish = { target: 'plugins/plug/commands/foo.md' };
    assert.equal(await ctx.confirmTurRemoval(c, false), false);
    c.publish = null;
    await ctx.confirmTurRemoval(c, false);
    const [withPublish, plainCase] = log.choices.splice(0);
    results[lang] = { withPublish, plainCase };
  }
  const view = (o) => ({ title: o.title, text: o.text, choices: o.choices.map((x) => x.id + '=' + x.label) });
  assert.deepEqual(view(results.tr.withPublish), {
    title: 'Prompt yayından çıkacak',
    text: 'Bu kayıtla "tur: komut" alanı kaldırılıyor ve prompt artık yayınlanmayacak. Yayındaki plugins/plug/commands/foo.md dosyası kaynaksız kalacak.',
    choices: ['cancel=Vazgeç', 'restore="tur: komut" geri koy ve kaydet', 'go=Yine de kaydet']
  });
  assert.deepEqual(view(results.en.withPublish), {
    title: 'The prompt will be unpublished',
    text: 'This save removes the "tur: komut" field, so the prompt will no longer be published. The published plugins/plug/commands/foo.md file will be left without a source.',
    choices: ['cancel=Cancel', 'restore=Restore "tur: komut" and save', 'go=Save anyway']
  });
  assert.equal(results.tr.plainCase.text, 'Bu kayıtla "tur: komut" alanı kaldırılıyor ve prompt artık yayınlanmayacak.');
  assert.equal(results.en.plainCase.text, 'This save removes the "tur: komut" field, so the prompt will no longer be published.');
});

test('git kimliği penceresi: başlık, metin ve düğmeler dile göre; kayıtlı kimlik kaçışlı', () => {
  const { ctx, g, log, S } = flowCtx();
  S.git.identity = { name: XSS, email: XSS };
  const out = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    ctx.askIdentity();
    out[lang] = log.modals.pop();
  }
  assert.equal(out.tr.title, 'Git kimliği');
  assert.equal(out.en.title, 'Git identity');
  assert.ok(out.tr.html.includes('<p>Git, commit yazarını bilmiyor. Bu marketplace için ad ve e-posta gir.</p>'));
  assert.ok(out.en.html.includes('<p>Git does not know the commit author. Enter a name and email for this marketplace.</p>'));
  assert.ok(out.tr.html.includes('<label>Ad Soyad<input id="idName"') && out.tr.html.includes('<label>E-posta<input id="idMail"'));
  assert.ok(out.en.html.includes('<label>Full name<input id="idName"') && out.en.html.includes('<label>Email<input id="idMail"'));
  assert.ok(out.tr.html.includes('data-act="close">Vazgeç</button><button class="btn primary">Kaydet</button>'));
  assert.ok(out.en.html.includes('data-act="close">Cancel</button><button class="btn primary">Save</button>'));
  assert.doesNotMatch(out.tr.html + out.en.html, /<img/);
  assert.ok(out.tr.html.includes('value="' + XSS_ESCAPED + '"'));
});

test('kaydet ve commit iletileri: beş sonuç iki dilde, commit hatası özeti sunucudan ham', async () => {
  const { ctx, g, log, c, S, env } = flowCtx();
  const results = [
    { mtime: 2, commit: 'abc1234' }, { mtime: 2, commitSkipped: true }, { mtime: 2, commitError: { error: 'Sunucu: hook reddetti', needIdentity: false } }, { mtime: 2 }
  ];
  const run = async () => {
    log.toasts.length = 0;
    for (const r of results) { env.api = async () => r; c.dirty = true; c.commitMsg = 'k'; await ctx.save(); }
    S.git = { isRepo: false };
    env.api = async () => ({ mtime: 3 });
    c.dirty = true;
    await ctx.save();
    S.git = { isRepo: true, files: [] };
    return plain(log.toasts);
  };
  g.I18n.setLanguage('tr');
  const tr = await run();
  g.I18n.setLanguage('en');
  const en = await run();
  assert.deepEqual(tr, [['Kaydedildi ve commit edildi (abc1234)'], ['Kaydedildi. Commit edilecek değişiklik yoktu.'], ['Kaydedildi ama commit atılamadı: Sunucu: hook reddetti', 'error'], ['Kaydedildi (commit edilmedi)'], ['Kaydedildi']]);
  assert.deepEqual(en, [['Saved and committed (abc1234)'], ['Saved. There was nothing to commit.'], ['Saved, but the commit failed: Sunucu: hook reddetti', 'error'], ['Saved (not committed)'], ['Saved']]);
  log.toasts.length = 0;
  env.api = async () => ({ commit: 'f00dbab' });
  g.I18n.setLanguage('tr');
  c.commitMsg = 'mesaj';
  await ctx.commitOnly();
  g.I18n.setLanguage('en');
  c.commitMsg = 'mesaj';
  await ctx.commitOnly();
  assert.deepEqual(plain(log.toasts), [['Commit edildi (f00dbab)'], ['Committed (f00dbab)']]);
});

test('diskte değişmiş çakışma penceresi: kaydetme akışındaki metinler dile göre, eylem kimlikleri sabit', async () => {
  const { ctx, g, log, env, c } = flowCtx();
  env.api = async () => { const e = new Error('x'); e.status = 409; e.data = { conflict: true }; throw e; };
  const out = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    c.dirty = true;
    await ctx.save();
    out[lang] = plain(log.choices.pop());
  }
  const view = (o) => ({ title: o.title, text: o.text, choices: o.choices.map((x) => x.id + '=' + x.label) });
  assert.deepEqual(view(out.tr), {
    title: 'Dosya diskte değişmiş', text: 'Bu dosya sen açtıktan sonra başka bir yerde (örneğin Claude Code veya editör) değiştirilmiş. Ne yapalım?',
    choices: ['cancel=Vazgeç', 'reload=Diskteki sürümü yükle', 'force=Diskteki sürümün üstüne yaz']
  });
  assert.deepEqual(view(out.en), {
    title: 'File changed on disk', text: 'This file was changed somewhere else (for example Claude Code or an editor) after you opened it. What should we do?',
    choices: ['cancel=Cancel', 'reload=Load the version on disk', 'force=Overwrite the version on disk']
  });
});

test('sürüm +1 penceresi: seviye seçenekleri, geçerli/son sürüm, notlar ve düğmeler dile göre; seviye kodları ve tag sabit', async () => {
  const { ctx, g, log, env } = flowCtx(SAMPLE, { dirty: true, commitMsg: 'mesaj ' + XSS });
  env.get = async () => ({ sonSurum: { version: '1.0.0', date: DATE_ISO }, tagOnek: 'prompt/foo/', degisti: false, notOnerisi: 'öneri' });
  const out = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    await ctx.openBump();
    out[lang] = { modal: log.modals.pop(), date: ctx.fmtDate(DATE_ISO) };
  }
  const trHtml = out.tr.modal.html;
  const enHtml = out.en.modal.html;
  assert.equal(out.tr.modal.title, 'Yeni sürüm');
  assert.equal(out.en.modal.title, 'New version');
  assert.ok(trHtml.includes('<legend>Seviye</legend>') && enHtml.includes('<legend>Level</legend>'));
  assert.ok(trHtml.includes('> Yama: 1.0.1 (düzeltme, küçük metin değişikliği)</label>') && enHtml.includes('> Patch: 1.0.1 (fix, small text change)</label>'));
  assert.ok(trHtml.includes('> Küçük: 1.1.0 (geriye uyumlu yeni davranış)</label>') && enHtml.includes('> Minor: 1.1.0 (new backward-compatible behavior)</label>'));
  assert.ok(trHtml.includes('> Büyük: 2.0.0 (davranış veya kullanım biçimi değişti)</label>') && enHtml.includes('> Major: 2.0.0 (behavior or usage changed)</label>'));
  for (const level of ['yama', 'kucuk', 'buyuk']) assert.ok(trHtml.includes('value="' + level + '"') && enHtml.includes('value="' + level + '"'), level);
  assert.ok(trHtml.includes('<p>Şu anki sürüm: <b>1.0.0</b>. Son sürüm: <b>v1.0.0</b> (' + out.tr.date + ')</p>'));
  assert.ok(enHtml.includes('<p>Current version: <b>1.0.0</b>. Last version: <b>v1.0.0</b> (' + out.en.date + ')</p>'));
  assert.ok(trHtml.includes('<label>Sürüm notu<textarea') && enHtml.includes('<label>Version note<textarea'));
  assert.ok(trHtml.includes('<p class="hint">Tag: <code id="bumpTag"></code></p>') && enHtml.includes('<p class="hint">Tag: <code id="bumpTag"></code></p>'));
  assert.ok(trHtml.includes('<p class="issue warn">Kaydedilmemiş değişiklikler de bu sürüme dahil edilecek.</p>'));
  assert.ok(enHtml.includes('<p class="issue warn">Unsaved changes will be included in this version too.</p>'));
  assert.ok(trHtml.includes('<p class="hint">Son sürümden beri içerik değişmedi; yalnızca sürüm numarası artacak.</p>'));
  assert.ok(enHtml.includes('<p class="hint">The content has not changed since the last version; only the version number will be bumped.</p>'));
  assert.ok(trHtml.includes('data-act="close">Vazgeç</button><button class="btn primary" id="bumpOk">Sürümü oluştur</button>'));
  assert.ok(enHtml.includes('data-act="close">Cancel</button><button class="btn primary" id="bumpOk">Create version</button>'));
  assert.doesNotMatch(trHtml + enHtml, /<img/);
  assert.ok(trHtml.includes('mesaj ' + XSS_ESCAPED) && enHtml.includes('mesaj ' + XSS_ESCAPED));
  assert.equal(skeleton(enHtml), skeleton(trHtml));
});

test('sürüm +1 penceresi: ilk sürüm, sürüm yok ve yorumlanamayan sürüm durumları dile göre', async () => {
  const { ctx, g, log, c, env } = flowCtx('---\nbaslik: A\n---\nx');
  env.get = async () => ({ sonSurum: null, tagOnek: 'prompt/foo/', degisti: true });
  const grab = async () => { await ctx.openBump(); return log.modals.pop().html; };
  const first = {};
  for (const lang of ['tr', 'en']) { g.I18n.setLanguage(lang); first[lang] = await grab(); }
  assert.ok(first.tr.includes('<p><b>İlk sürüm: 1.0.0</b></p>') && first.en.includes('<p><b>First version: 1.0.0</b></p>'));
  assert.ok(first.tr.includes('<p>Şu anki sürüm: <b>yok</b>. Henüz sürüm yok</p>'));
  assert.ok(first.en.includes('<p>Current version: <b>none</b>. No version yet</p>'));
  c.parsed = FM.parse('---\nversiyon: ' + XSS + '\n---\nx');
  const bad = {};
  for (const lang of ['tr', 'en']) { g.I18n.setLanguage(lang); bad[lang] = await grab(); }
  assert.ok(bad.tr.includes('<p class="issue error">Sürüm yorumlanamadı. X.Y.Z biçiminde yaz (örnek: 1.0.0).</p>'));
  assert.ok(bad.en.includes('<p class="issue error">The version could not be interpreted. Write it in the X.Y.Z format (example: 1.0.0).</p>'));
  assert.doesNotMatch(bad.tr + bad.en, /<img/);
  assert.ok(bad.tr.includes('Yama (düzeltme, küçük metin değişikliği)') && bad.en.includes('Patch (fix, small text change)'));
});

test('kopyalama: değişkenli pencere (çoğul), düğmeler, panoya kopyalama iletileri ve karakter çoğulu dile göre', async () => {
  const { ctx, g, log, c, env } = flowCtx('---\nbaslik: A\n---\nGövde {{ad}} ve {{<b>}}');
  const out = {};
  for (const lang of ['tr', 'en']) { g.I18n.setLanguage(lang); await ctx.copyBody(); out[lang] = log.modals.pop(); }
  assert.equal(out.tr.title, 'Değişkenleri doldur');
  assert.equal(out.en.title, 'Fill in the variables');
  assert.ok(out.tr.html.includes('<p class="hint">Bu promptta 2 değişken var. Boş bıraktıkların <code>{{ad}}</code> olarak kalır. Değerler bir sonraki sefer için hatırlanır.</p>'));
  assert.ok(out.en.html.includes('<p class="hint">This prompt has 2 variables. Any you leave empty stay as <code>{{name}}</code>. Values are remembered for next time.</p>'));
  assert.ok(out.tr.html.includes('data-act="close">Vazgeç</button><button type="button" class="btn" data-act="copy-raw-vars">Değişkenleri doldurmadan kopyala</button><button class="btn primary">Doldur ve kopyala</button>'));
  assert.ok(out.en.html.includes('data-act="close">Cancel</button><button type="button" class="btn" data-act="copy-raw-vars">Copy without filling in the variables</button><button class="btn primary">Fill in and copy</button>'));
  assert.doesNotMatch(out.tr.html + out.en.html, /<img/);
  assert.ok(out.tr.html.includes('data-var="&lt;b&gt;"'));
  c.parsed = FM.parse('---\nbaslik: A\n---\nGövde {{tek}}');
  g.I18n.setLanguage('en');
  await ctx.copyBody();
  assert.ok(log.modals.pop().html.includes('This prompt has 1 variable. If you leave it empty, it stays as <code>{{name}}</code>.'));
  c.parsed = FM.parse('---\nbaslik: A\n---\n');
  const toasts = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    log.toasts.length = 0;
    await ctx.copyBody();
    env.copyOk = false;
    await ctx.copyBody();
    env.copyOk = true;
    toasts[lang] = plain(log.toasts);
  }
  assert.deepEqual(toasts.tr, [['Panoya kopyalandı (1 karakter)', 'ok'], ['Kopyalanamadı, metni elle seç', 'error']]);
  assert.deepEqual(toasts.en, [['Copied to clipboard (1 character)', 'ok'], ['Could not copy; select the text manually', 'error']]);
  c.parsed = FM.parse('---\nbaslik: A\n---\nmetin');
  g.I18n.setLanguage('en');
  log.toasts.length = 0;
  await ctx.copyBody();
  assert.equal(log.toasts[0][0], 'Copied to clipboard (6 characters)');
});

test('eski içeriği editöre alma: kaydedilmemiş değişiklik penceresi, geri yükleme verisi, commit mesajı ve ileti dile göre', async () => {
  const { ctx, g, log, c, env } = flowCtx(SAMPLE, { hist: { commit: { commits: [{ hash: 'b'.repeat(40), short: 'bbbbbbb', path: 'prompts/plug/a.md' }] }, ver: { view: null, data: { versions: [] } } } });
  env.get = async () => ({ raw: '---\nbaslik: Y\n---\nz', version: '1.5.0' });
  const dirty = {};
  c.dirty = true;
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    log.choices.length = 0;
    await ctx.loadVersionIntoEditor('t');
    await ctx.loadOldVersion('b'.repeat(40));
    dirty[lang] = log.choices.map((o) => ({ title: o.title, text: o.text, choices: o.choices.map((x) => x.id + '=' + x.label) }));
  }
  assert.deepEqual(dirty.tr, [
    { title: 'Kaydedilmemiş değişiklikler var', text: '"a.md" dosyasındaki kaydedilmemiş değişiklikler, v1.5.0 sürümünün içeriğiyle değiştirilecek.', choices: ['cancel=Vazgeç', 'discard=Değişiklikleri at ve yükle', 'save=Önce kaydet'] },
    { title: 'Kaydedilmemiş değişiklikler var', text: '"a.md" dosyasındaki kaydedilmemiş değişiklikler, bbbbbbb commit\'inin içeriğiyle değiştirilecek.', choices: ['cancel=Vazgeç', 'discard=Değişiklikleri at ve yükle', 'save=Önce kaydet'] }
  ]);
  assert.deepEqual(dirty.en, [
    { title: 'You have unsaved changes', text: 'The unsaved changes in "a.md" will be replaced with the content of v1.5.0.', choices: ['cancel=Cancel', 'discard=Discard changes and load', 'save=Save first'] },
    { title: 'You have unsaved changes', text: 'The unsaved changes in "a.md" will be replaced with the content of commit bbbbbbb.', choices: ['cancel=Cancel', 'discard=Discard changes and load', 'save=Save first'] }
  ]);
  c.dirty = false;
  const restored = {};
  for (const lang of ['tr', 'en']) {
    g.I18n.setLanguage(lang);
    c.commitMsg = '';
    c.restoredFrom = null;
    log.toasts.length = 0;
    await ctx.loadVersionIntoEditor('t');
    const fromVersion = { restoredFrom: plain(c.restoredFrom), commitMsg: c.commitMsg, toast: log.toasts[0][0] };
    c.commitMsg = '';
    c.restoredFrom = null;
    await ctx.loadOldVersion('b'.repeat(40));
    restored[lang] = { fromVersion, commitMsg: c.commitMsg, restoredFrom: plain(c.restoredFrom) };
  }
  assert.deepEqual(restored.tr.fromVersion, { restoredFrom: { source: 'version', version: '1.5.0' }, commitMsg: 'v1.5.0 sürümüne geri dönüldü', toast: 'Eski içerik editöre alındı. Kaydedene kadar dosya değişmez.' });
  assert.deepEqual(restored.en.fromVersion, { restoredFrom: { source: 'version', version: '1.5.0' }, commitMsg: 'Reverted to v1.5.0', toast: 'The old content was loaded into the editor. The file does not change until you save.' });
  assert.equal(restored.tr.commitMsg, "bbbbbbb commit'ine geri dönüldü");
  assert.equal(restored.en.commitMsg, 'Reverted to commit bbbbbbb');
  assert.deepEqual(restored.en.restoredFrom, { source: 'commit', short: 'bbbbbbb' });
});

test('yazma sonrası yayın kullanım ipucu: komut ve ajan metni dile göre, ad ve paket kaçışlı', async () => {
  const g = browserEnv();
  const dom = fakeDom();
  const c = makeCur(SAMPLE);
  const env = { publish: { tur: 'komut', paket: 'plug', ad: XSS } };
  const S = { cur: c, gen: 0 };
  const ctx = load({ fns: ['afterWrite'], consts: ['esc'] }, {
    ...g, S, $: dom.$, loadLibrary: async () => {}, loadFacets: async () => {}, loadGit: async () => {}, loadRecent: async () => {}, renderFilters() {}, renderList() {},
    isFiltering: () => false, runSearch() {}, loadVersion() {}, pubPill: () => '<pill>', qs: () => 'path=a', get: async () => ({ publish: env.publish, generatedFrom: null })
  });
  const usage = async (lang) => { g.I18n.setLanguage(lang); await ctx.afterWrite(); return dom.els['#pubUsage'].innerHTML; };
  assert.equal(await usage('tr'), "Claude Code'da çağır: <code>/plug:" + XSS_ESCAPED + '</code>');
  assert.equal(await usage('en'), 'Invoke in Claude Code: <code>/plug:' + XSS_ESCAPED + '</code>');
  env.publish = { tur: 'ajan', paket: 'plug', ad: 'foo' };
  assert.equal(await usage('tr'), 'Ajan adı: <code>foo</code>');
  assert.equal(await usage('en'), 'Agent name: <code>foo</code>');
});

test('sürüm ve paket ipuçları: paintVerHint, paintVerWarn ve paintPaketHint dile göre; sunucu iletisi ham', () => {
  const g = browserEnv();
  const dom = fakeDom();
  const c = makeCur('---\nversiyon: v1.2\n---\nx');
  const S = { info: { activeMarketplace: 'mp' }, cur: c };
  const ctx = load({ fns: ['paintVerHint', 'paintVerWarn', 'paintPaketHint'], consts: ['esc', 'str', 'fold'] }, { ...g, S, $: dom.$, libDirOf: () => 'prompts' });
  const hint = (raw) => { c.parsed = FM.parse('---\nversiyon: ' + raw + '\n---\nx'); ctx.paintVerHint(); return [dom.els['#verHint'].textContent, dom.els['#verHint'].hidden]; };
  const legacy = inLangs(g, () => hint('v1.2'));
  assert.deepEqual(legacy.tr, ['Eski biçim: "v1.2", 1.2.0 olarak yorumlanır.', false]);
  assert.deepEqual(legacy.en, ['Old format: "v1.2", interpreted as 1.2.0.', false]);
  const bad = inLangs(g, () => hint('abc'));
  assert.equal(bad.tr[0], 'Sürüm yorumlanamadı. X.Y.Z biçiminde yaz (örnek: 1.0.0).');
  assert.equal(bad.en[0], 'The version could not be interpreted. Write it in the X.Y.Z format (example: 1.0.0).');
  assert.deepEqual(inLangs(g, () => hint('1.0.0')).en, ['', true]);
  c.ver = { uyari: { message: 'Sunucu Türkçe iletisi' }, sonSurum: { version: '1.0.0' } };
  const warn = inLangs(g, () => { ctx.paintVerWarn(); const w = dom.els['#verWarn']; return [w.textContent, w.title, w.attrs['aria-label']]; });
  assert.deepEqual(warn.tr, ["v1.0.0'dan beri değişti", 'Sunucu Türkçe iletisi', 'Sunucu Türkçe iletisi']);
  assert.deepEqual(warn.en, ['Changed since v1.0.0', 'Sunucu Türkçe iletisi', 'Sunucu Türkçe iletisi']);
  c.parsed = FM.parse('---\npaket: ' + XSS + '\n---\nx');
  const pk = inLangs(g, () => { ctx.paintPaketHint(); return dom.els['#paketHint'].innerHTML; });
  assert.ok(pk.tr.includes('data-act="paket-esitle">Alanı klasöre eşitle</button> <button type="button" class="btn sm" data-act="m-move" data-path="prompts/plug/a.md">Dosyayı taşı</button>'), pk.tr);
  assert.ok(pk.en.includes('data-act="paket-esitle">Match the field to the folder</button> <button type="button" class="btn sm" data-act="m-move" data-path="prompts/plug/a.md">Move the file</button>'), pk.en);
  assert.doesNotMatch(pk.tr + pk.en, /<img/);
  assert.ok(pk.tr.startsWith('Dosya &quot;plug&quot; paketinin klasöründe ama &quot;paket&quot; alanı &quot;' + XSS_ESCAPED), pk.tr);
  assert.ok(pk.en.startsWith('The file is in the folder of package &quot;plug&quot; but its &quot;paket&quot; field is &quot;' + XSS_ESCAPED), pk.en);
});

test('refreshChips: yer tutucu etiket ve proje alanı için dile göre değişir', () => {
  const g = browserEnv();
  const c = makeCur(SAMPLE);
  const S = { cur: c };
  let captured = '';
  const holder = { querySelector: () => null, parentNode: {}, replaceWith() {} };
  const ctx = load({ fns: ['refreshChips', 'chipsHtml'], consts: ['esc', 'toList'] }, {
    ...g, S, $: () => holder, document: { createElement: () => ({ set innerHTML(v) { captured = v; this.firstElementChild = {}; } }) }
  });
  const placeholder = (key) => { ctx.refreshChips(key); return /placeholder="([^"]*)"/.exec(captured)[1]; };
  const tags = inLangs(g, () => placeholder('etiketler'));
  const projects = inLangs(g, () => placeholder('projeler'));
  assert.deepEqual([tags.tr, tags.en], ['Etiket ekle, Enter', 'Add a tag, Enter']);
  assert.deepEqual([projects.tr, projects.en], ['Hangi projelerde kullanılıyor?', 'Which projects is it used in?']);
});

test('sözlük: bölgenin tr değerleri bugünkü metnin harfi harfine aynısı (kilit)', () => {
  const locked = {
    'ui.common.none': 'yok',
    'ui.common.openGitPanel': 'Git panelini aç',
    'ui.fields.allowedTools': 'İzinli araçlar',
    'ui.main.staleBanner': "Bu dosya <b>{mp}</b> marketplace'ine ait ama etkin marketplace şu an <b>{active}</b>. Kaydetmek için dosyayı ağaçtan yeniden aç.",
    'ui.main.restoredCommit': "Editörde {short} commit'inin içeriği var (kaydedilmedi). Kaydedersen dosya bu içerikle değişir.",
    'ui.main.commitPlaceholder': 'Ne değişti, neden? (boşsa yalnızca kaydedilir)',
    'ui.edit.bumpTitle': 'Yeni sürüm oluştur: versiyon artar, commit ve tag atılır',
    'ui.edit.usageCommand': "Claude Code'da çağır: <code>/{paket}:{name}</code>",
    'ui.edit.bodyPlaceholder': 'Prompt metnini buraya yaz. {example} biçiminde yer tutucular kullanabilirsin.',
    'ui.edit.changedSince': "v{version}'dan beri değişti",
    'ui.edit.unpublishTextPublished': 'Bu kayıtla "tur: {value}" alanı kaldırılıyor ve prompt artık yayınlanmayacak. Yayındaki {target} dosyası kaynaksız kalacak.',
    'ui.save.savedCommitFailed': 'Kaydedildi ama commit atılamadı: {reason}',
    'ui.conflict.textBump': 'Bu dosya sen açtıktan sonra başka bir yerde değiştirilmiş. Ne yapalım?',
    'ui.conflict.textSave': 'Bu dosya sen açtıktan sonra başka bir yerde (örneğin Claude Code veya editör) değiştirilmiş. Ne yapalım?',
    'ui.bump.currentWithLast': 'Şu anki sürüm: <b>{current}</b>. Son sürüm: <b>v{version}</b> ({date})',
    'ui.copy.copyRaw': 'Değişkenleri doldurmadan kopyala',
    'ui.hist.stale': "Bu dosya {mp} marketplace'ine ait ama etkin marketplace {active}. Geçmişi görmek için dosyayı ağaçtan yeniden aç.",
    'ui.hist.modeCommits': "Commit'ler",
    'ui.hist.untrackedDiff': "Bu dosya henüz git'e eklenmedi. Git panelinden commit edebilirsin.",
    'ui.hist.replaceUnsavedCommit': '"{name}" dosyasındaki kaydedilmemiş değişiklikler, {short} commit\'inin içeriğiyle değiştirilecek.',
    'ui.ver.readOnly': '({date}), salt okunur',
    'ui.ver.byTagger': 'Sürümü oluşturan: {tagger}, commit {short}'
  };
  for (const [key, text] of Object.entries(locked)) {
    assert.equal(TR[key], text, key);
    assert.equal(typeof EN[key], 'string', 'en ' + key);
    assert.notEqual(EN[key], text, 'en çevrilmiş ' + key);
  }
  assert.equal(TR['ui.fields.version'], 'Versiyon');
  assert.equal(TR['ui.edit.version'], 'Sürüm');
  assert.equal(TR['ui.edit.turUnrecognized'], '⚠ "{value}" (tanınmadı)');
  assert.equal(TR['ui.bump.levelOption'], '{level}: {version} ({desc})');
  assert.equal(TR['ui.hist.hunk'], '@@ satır {line} @@');
  assert.equal(TR['ui.ver.rangeCommits'], "Bu aralıktaki commit'ler ({total})");
  assert.deepEqual(TR['ui.main.startIntro'], { other: 'Havuzunda {count} prompt var. Soldaki listeden veya arama kutusundan birini aç. Sık kopyaladıklarını etiketle, değiştirdiklerini git ile kaydet.' });
  assert.deepEqual(TR['ui.edit.bodyInfo'], { other: '{count} kelime, {chars}' });
  assert.deepEqual(TR['ui.edit.charCount'], { other: '{count} karakter' });
  assert.deepEqual(TR['ui.hist.ignoredTags'], { other: '{count} tag sürüm biçimine uymadığı için atlandı.' });
  assert.deepEqual(TR['ui.copy.copiedChars'], { other: 'Panoya kopyalandı ({count} karakter)' });
  assert.deepEqual(Object.keys(EN['ui.edit.bodyInfo']).sort(), ['one', 'other']);
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

/** Summary: ana alan başlığından yeni marketplace, plugin, prompt başlığına kadar olan kaynak bölgesi. */
function regionSource() {
  const start = /^\/\* -+ ana alan \*\/$/m.exec(html);
  const end = /^\/\* -+ yeni marketplace, plugin, prompt \*\/$/m.exec(html);
  assert.ok(start && end && start.index < end.index, 'bölge başlıkları bulunamadı');
  return html.slice(start.index, end.index);
}

test('kalıntı taraması: bölgede çevrilmemiş Türkçe dize değişmezi yok (yalnızca veri değerleri kalır)', () => {
  const literals = stringLiterals(regionSource());
  assert.ok(literals.length > 600, 'tarayıcı gerçekten dizeleri buluyor: ' + literals.length);
  const dataValues = new Set(['kararlı', 'arşiv']);
  assert.deepEqual(literals.filter((text) => DIACRITIC_RE.test(text) && !dataValues.has(text)), []);
  const words = /\b(?:Yeni|Eski|Sil|Kaydet|Kaydedildi|Tamam|Vazgeç|Taşı|Henüz|Yükleniyor|Gelen kutusu|Klasörsüz|Teknik|Düzenle|Geçmiş|Sürüm|Kopyala|Kapat|Görüntüle|Değişkenler|Etiketler|Projeler|Açıklama|Başlık|Paket|Komut|Ajan|Dosya|Bu dosya|Commit|Karşılaştır|Seviye|Taslak|Kararlı|Arşiv)\b/;
  assert.deepEqual(literals.filter((text) => words.test(text)), []);
});

test('bölge: çıplak ${tx(} yok, etiket tablosu tek satırlık sabit, raw kullanımı ve LF', () => {
  const region = regionSource();
  assert.doesNotMatch(region, /\$\{\s*(?:I18n\.)?tx\(/);
  assert.match(region, /^const FIELD_LABEL_KEYS = \{.*\};$/m);
  assert.doesNotMatch(region, /^const FIELD_LABEL = /m);
  assert.match(region, /I18n\.raw\(/);
  assert.ok(!html.includes('\r'));
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
