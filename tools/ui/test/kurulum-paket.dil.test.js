'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const I18n = require('../public/i18n.js');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');
const ppConfig = require('../lib/pp-config');
const { ConfigStore } = require('../lib/config-store');
const { GitService } = require('../lib/git-service');
const { SetupService } = require('../lib/setup-service');
const { MarketplaceRegistry } = require('../lib/marketplace-registry');
const { MarketplaceFactory } = require('../lib/marketplace-factory');
const { LibraryCatalog } = require('../lib/library-catalog');
const { PackageService, PackageError } = require('../lib/package-service');
const { UndoStack } = require('../lib/undo');
const templates = require('../lib/templates');
const { gitAvailable, tmpDir, rmrf } = require('./helpers');
const { seed, write, cmd, commitAll, buildStack } = require('./stack');
const { makeLink, removeLink } = require('./links');

const LIB = path.join(__dirname, '..', 'lib');
const SOURCES = [
  'setup-service.js', 'pp-config.js', 'marketplace-registry.js', 'marketplace-factory.js',
  'library-catalog.js', 'package-service.js', 'package-catalog.js', 'version-advisor.js'
];
const NAMESPACES = ['setup.', 'cfg.', 'mp.', 'pkg.', 'ver.adv.'];
const REUSED_RULE_KEYS = ['rules.pluginAdGerekli', 'rules.mpAdNokta'];
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;
const real = { skip: !gitAvailable && 'git yok' };
const EXPECTED_KEYS = [
  'setup.ayarDosyasiBozuk', 'setup.kokAyarlanmadi', 'setup.kokYok', 'setup.kokAracReposunda', 'setup.gitBulunamadi',
  'setup.kokBaskaDepoda', 'setup.kokAracReposunuIceriyor', 'setup.marketplaceYok', 'setup.marketplaceSecilmedi',
  'setup.marketplaceBulunamadi', 'setup.marketplaceGitYok', 'setup.marketplaceGitYokNeden', 'setup.ppConfigYok',
  'cfg.type.array', 'cfg.type.string', 'cfg.type.number', 'cfg.type.boolean', 'cfg.type.object',
  'cfg.reason.json', 'cfg.reason.unreadable', 'cfg.reason.unreadableCode', 'cfg.reason.notObject', 'cfg.outsideMarketplace',
  'cfg.bozuk', 'cfg.libraryDirGecersiz', 'cfg.exportAlanGecersiz', 'cfg.exportGecersiz',
  'mp.reason.aracReposu', 'mp.reason.gitDegil', 'mp.reason.kokDepoDegil', 'mp.reason.gitOkunamadi', 'mp.reason.gitOkunamadiDetay',
  'mp.catalog.publishName', 'mp.err.invalidName', 'mp.err.folderExists', 'mp.err.createFailed', 'mp.err.cloneFailed',
  'mp.err.cloneNotRoot', 'mp.err.folderNotFound', 'mp.err.alreadyGit', 'mp.err.initFailed',
  'mp.warn.ppConfigYok', 'mp.warn.manifestYok', 'mp.warn.bosDepo',
  'pkg.err.exists', 'pkg.err.notFound', 'pkg.err.sameName', 'pkg.err.descriptionEmpty', 'pkg.err.createFailed',
  'pkg.err.renameFailed', 'pkg.err.rollbackFailed', 'pkg.skip.paketDisiKlasor', 'pkg.issue.icerikBos',
  'pkg.issue.aciklamaBosKomut', 'pkg.issue.aciklamaBosAjan', 'pkg.issue.aciklamaBosSkill', 'pkg.issue.hedefCakisiyor',
  'ver.adv.ilkYayin', 'ver.adv.sadeceEtiket', 'ver.adv.degisiklikYok', 'ver.adv.yeniDosya', 'ver.adv.degisenDosya',
  'ver.adv.kaldirilanDosya', 'ver.adv.aciklamaDegisti', 'ver.adv.surumSinir', 'ver.adv.bos', 'ver.adv.yayinlanacakYok',
  'ver.adv.surumGeride'
].sort();
/** Summary: Bilinçli olarak çevrilmeyen Türkçe dize değişmezleri (pp-config varsayılan verisi ve durum değerleri). */
const ALLOWED_TURKISH_LITERALS = ['Kişisel prompt havuzu', 'kararlı'];
const IGNORE = new Set(Rules.RESERVED_DIRS);
const EDITABLE = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml']);

/** Summary: Çağrıyı İngilizce dil bağlamında çalıştırır. */
const inEn = (fn) => I18n.run('en', fn);

/** Summary: Çağrıyı Türkçe dil bağlamında çalıştırır. */
const inTr = (fn) => I18n.run('tr', fn);

/** Summary: Bu aşamanın ad uzaylarındaki sözlük anahtarları, sıralı. */
function stageKeys(dictionary) {
  return Object.keys(dictionary).filter((key) => NAMESPACES.some((ns) => key.startsWith(ns))).sort();
}

/** Summary: Şablondaki yer tutucu adları, tekil ve sıralı. */
function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
}

/** Summary: Sözlük değerini kategori -> metin haritasına çevirir (düz metin için tek 'text' girdisi). */
function variants(value) {
  return typeof value === 'string' ? { text: value } : value;
}

/** Summary: Kaynaktaki dize değişmezlerini yorumları ve düzenli ifade değişmezlerini atlayarak çıkarır. */
function stringLiterals(src) {
  const found = [];
  const beforeRegex = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);
  let i = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') { const end = src.indexOf('\n', i); i = end < 0 ? src.length : end; continue; }
    if (c === '/' && next === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      found.push(src.slice(i + 1, j));
      i = j + 1;
      prev = 'x';
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

/** Summary: Git saplaması: kurulum ve kayıt defteri testlerinde gerçek git çalıştırmaz. */
function stubGit(over = {}) {
  return {
    version: async () => 'git version test',
    toplevel: async () => null,
    toplevelInfo: async () => ({ path: null, error: null }),
    ...over
  };
}

/** Summary: ileti metninden bağımsız hata kodu taşıyan toplevelInfo sonucu (GitService boş yanıtı gibi). */
function emptyResponseInfo() {
  return Object.defineProperty({ path: null, error: 'Boş yanıt' }, 'errorCode', { value: 'bosYanit' });
}

/** Summary: Saplama git ile SetupService kurar; cfg verilirse ayar dosyasına yazılır, rawCfg verilirse olduğu gibi. */
async function buildSetup(d, { cfg, rawCfg, git } = {}) {
  const tool = path.join(d, 'arac'); fs.mkdirSync(tool, { recursive: true });
  const file = path.join(d, 'cfg', 'config.json');
  const store = new ConfigStore({ file });
  if (rawCfg !== undefined) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, rawCfg); }
  else if (cfg) await store.save(cfg);
  const stub = git || stubGit();
  const registry = new MarketplaceRegistry({ git: stub, toolRoot: tool });
  return { svc: new SetupService({ configStore: store, registry, git: stub, toolRoot: tool }), tool, store, git: stub };
}

/** Summary: Aynı SetupService durumunu iki dilde okur ve beklenen iletiyle karşılaştırır (önbellekte dil sızmaz). */
async function assertIssueText(svc, code, want, level) {
  const find = () => svc.current.issues.find((i) => i.code === code);
  for (const run of [inTr, inEn, inTr, inEn]) {
    const lang = run === inTr ? 'tr' : 'en';
    const issue = find();
    assert.ok(issue, code + ' bulunamadı: ' + JSON.stringify(svc.current.issues.map((i) => i.code)));
    assert.equal(run(() => issue.message), want[lang], code + ' ' + lang);
    const viaJson = run(() => JSON.parse(JSON.stringify(svc.current.issues)).find((i) => i.code === code));
    assert.equal(viaJson.message, want[lang], code + ' JSON ' + lang);
    if (level) assert.equal(issue.level, level);
  }
  assert.equal(svc.current.issues.find((i) => i.code === code).message, want.tr, 'bağlamsız okuma tr');
}

/** Summary: Durumu önce İngilizce, sonra Türkçe bağlamda hesaplar; her ikisinde de iletiler okuma diliyle çıkar. */
async function evaluateBoth(svc, code, want, level) {
  await inEn(() => svc.evaluate());
  await assertIssueText(svc, code, want, level);
  svc.invalidate();
  await inTr(() => svc.evaluate());
  await assertIssueText(svc, code, want, level);
}

test('setup: issue şekli (code, level, message, path, action) korunur; message numaralandırılabilir tembel alıcı; spread ve deepEqual çalışır', async () => {
  const d = tmpDir();
  try {
    const { svc } = await buildSetup(d);
    const st = await inEn(() => svc.evaluate());
    const issue = st.issues[0];
    assert.deepEqual(Object.keys(issue), ['code', 'level', 'message', 'path', 'action']);
    const desc = Object.getOwnPropertyDescriptor(issue, 'message');
    assert.equal(typeof desc.get, 'function');
    assert.equal(desc.enumerable, true);
    assert.equal(inEn(() => ({ ...issue }).message), 'Library root is not set. Choose a folder in Settings.');
    assert.equal(inTr(() => ({ ...issue }).message), "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.");
    assert.deepEqual(
      inTr(() => JSON.parse(JSON.stringify(st))),
      { ok: false, rootOk: false, libraryRoot: '', activeMarketplace: '', root: null,
        issues: [{ code: 'kokAyarlanmadi', level: 'error', message: "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.", path: null, action: 'ayarlar' }] }
    );
    assert.deepEqual(
      inEn(() => JSON.parse(JSON.stringify(st.issues))),
      [{ code: 'kokAyarlanmadi', level: 'error', message: 'Library root is not set. Choose a folder in Settings.', path: null, action: 'ayarlar' }]
    );
    inTr(() => assert.deepEqual({ ...issue }, { code: 'kokAyarlanmadi', level: 'error', message: "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.", path: null, action: 'ayarlar' }));
  } finally { rmrf(d); }
});

test('setup: önbellekte dil sızmaz, kök sorunları (aynı örnek önce en sonra tr, her okuma kendi dilinde)', async () => {
  const d = tmpDir();
  try {
    {
      const { svc } = await buildSetup(d);
      await evaluateBoth(svc, 'kokAyarlanmadi',
        { tr: "Library kökü ayarlanmadı. Ayarlar'dan bir klasör seç.", en: 'Library root is not set. Choose a folder in Settings.' }, 'error');
    }
    {
      const missing = path.join(d, 'yok');
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: missing } });
      await evaluateBoth(svc, 'kokYok', {
        tr: 'Library kökü diskte bulunamadı: ' + missing, en: 'Library root was not found on disk: ' + missing
      }, 'error');
    }
    {
      const { svc, tool } = await buildSetup(d, { cfg: { libraryRoot: path.join(d, 'arac') } });
      await evaluateBoth(svc, 'kokAracReposunda', {
        tr: `Library kökü araç reposunun içinde: ${tool}. Araç reposunun dışında bir klasör seç.`,
        en: `Library root is inside the tool repository: ${tool}. Choose a folder outside the tool repository.`
      }, 'error');
    }
    {
      const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib }, git: stubGit({ version: async () => { throw new Error('yok'); } }) });
      await evaluateBoth(svc, 'gitBulunamadi', {
        tr: 'Git bulunamadı. Git kurulu ve PATH içinde olmalı.', en: 'Git was not found. Git must be installed and available in PATH.'
      }, 'error');
      assert.equal(svc.current.rootOk, false);
    }
  } finally { rmrf(d); }
});

test('setup: önbellekte dil sızmaz, marketplace sorunları ve uyarılar', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    {
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib } });
      await evaluateBoth(svc, 'marketplaceYok', {
        tr: 'Library kökünde hiç marketplace yok. Yeni bir marketplace oluştur.',
        en: 'There are no marketplaces in the library root. Create a new marketplace.'
      }, 'error');
    }
    fs.mkdirSync(path.join(lib, 'a', '.git'), { recursive: true });
    {
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib } });
      await evaluateBoth(svc, 'marketplaceSecilmedi', { tr: 'Marketplace seçilmedi.', en: 'No marketplace is selected.' }, 'error');
    }
    {
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib, activeMarketplace: 'yok' } });
      await evaluateBoth(svc, 'marketplaceBulunamadi', {
        tr: 'Seçili marketplace bulunamadı: yok', en: 'The selected marketplace was not found: yok'
      }, 'error');
    }
    {
      const outer = path.join(d, 'dis');
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib }, git: stubGit({ toplevel: async () => outer }) });
      await evaluateBoth(svc, 'kokBaskaDepoda', {
        tr: `Library kökü başka bir git deposunun içinde (${outer}). Marketplace depoları iç içe depo olarak görünebilir.`,
        en: `Library root is inside another git repository (${outer}). Marketplace repositories may appear as nested repositories.`
      }, 'warn');
    }
    {
      const { svc } = await buildSetup(d, { cfg: { libraryRoot: d } });
      await evaluateBoth(svc, 'kokAracReposunuIceriyor', {
        tr: 'Library kökü araç reposunu içeriyor. Araç reposu marketplace olarak kullanılmaz.',
        en: 'Library root contains the tool repository. The tool repository is not used as a marketplace.'
      }, 'warn');
    }
    {
      const file = path.join(d, 'cfg', 'config.json');
      const { svc } = await buildSetup(d, { rawCfg: '{bozuk' });
      await evaluateBoth(svc, 'ayarDosyasiBozuk', {
        tr: 'Ayar dosyası okunamadı, varsayılanlarla devam ediliyor: ' + file,
        en: 'The settings file could not be read, continuing with defaults: ' + file
      }, 'warn');
    }
  } finally { rmrf(d); }
});

test('setup: marketplaceGitYok nedenleri (.git yok, kök başka, git ayrıntısı, boş yanıt, ayrıntısız) iki dilde', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib');
    fs.mkdirSync(path.join(lib, 'duz'), { recursive: true });
    const cfg = { libraryRoot: lib, activeMarketplace: 'duz' };
    const base = (reasonTr, reasonEn) => ({
      tr: "Seçili marketplace'te git başlatılmamış: duz" + (reasonTr ? ` (${reasonTr})` : ''),
      en: 'Git is not initialized in the selected marketplace: duz' + (reasonEn ? ` (${reasonEn})` : '')
    });
    {
      const { svc } = await buildSetup(d, { cfg });
      await evaluateBoth(svc, 'marketplaceGitYok', base('', ''), 'error');
      assert.equal(svc.current.issues[0].action, 'gitBaslat');
    }
    fs.mkdirSync(path.join(lib, 'duz', '.git'));
    const cases = [
      [{ path: lib, error: null }, 'Git deposu kökü bu klasör değil', 'The git repository root is not this folder'],
      [{ path: null, error: 'fatal: ilk satir\nikinci satir' }, 'fatal: ilk satir', 'fatal: ilk satir'],
      [emptyResponseInfo(), 'Boş yanıt', 'Empty response'],
      [{ path: null, error: null }, 'Git deposu okunamadı', 'The git repository could not be read']
    ];
    for (const [info, reasonTr, reasonEn] of cases) {
      const { svc } = await buildSetup(d, { cfg, git: stubGit({ toplevelInfo: async () => info }) });
      await evaluateBoth(svc, 'marketplaceGitYok', base(reasonTr, reasonEn), 'error');
    }
  } finally { rmrf(d); }
});

test('setup: ppConfigYok ve pp-config sorunları (ppConfigBozuk, libraryDirGecersiz, exportAlanGecersiz) önbellekte dil taşımaz', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib');
    const a = path.join(lib, 'a');
    fs.mkdirSync(path.join(a, '.git'), { recursive: true });
    const git = stubGit({ toplevelInfo: async (dir) => ({ path: dir, error: null }) });
    const { svc } = await buildSetup(d, { cfg: { libraryRoot: lib, activeMarketplace: 'a' }, git });
    await evaluateBoth(svc, 'ppConfigYok', {
      tr: "Bu marketplace'te pp.config.json yok. Prompt Havuzu ayarlarını oluştur.",
      en: 'This marketplace has no pp.config.json. Create the Prompt Havuzu settings.'
    }, 'warn');
    assert.equal(svc.current.issues[0].action, 'ppConfigOlustur');
    const file = path.join(a, 'pp.config.json');
    fs.writeFileSync(file, '[]');
    svc.invalidate();
    await inEn(() => svc.evaluate());
    const bozuk = svc.current.issues[0];
    assert.equal(bozuk.code, 'ppConfigBozuk');
    assert.equal(bozuk.path, file);
    assert.match(inTr(() => bozuk.message), /^pp\.config\.json okunamadı \(kök bir nesne değil, dizi\)\. Geçici olarak/);
    assert.match(inEn(() => bozuk.message), /^pp\.config\.json could not be read \(the root is not an object, found: array\)\. Default settings/);
    fs.writeFileSync(file, JSON.stringify({ libraryDir: '../disari', export: { durumlar: 'a' } }));
    svc.invalidate();
    await inTr(() => svc.evaluate());
    const [dir, exp] = svc.current.issues;
    assert.deepEqual([dir.code, exp.code], ['libraryDirGecersiz', 'exportAlanGecersiz']);
    assert.match(inEn(() => dir.message), /^The "libraryDir" value in pp\.config\.json is invalid \(cannot contain "\.\."\)\. "library" is used temporarily/);
    assert.match(inTr(() => dir.message), /^pp\.config\.json içindeki "libraryDir" geçersiz \("\.\." içeremez\)\. Geçici olarak "library" kullanılıyor/);
    assert.match(inEn(() => exp.message), /^The "export\.durumlar" value in pp\.config\.json must be an array \(currently: string\)/);
    assert.match(inTr(() => exp.message), /^pp\.config\.json içindeki "export\.durumlar" dizi olmalı \(şu an: metin\)/);
    assert.deepEqual(inEn(() => JSON.parse(JSON.stringify(svc.current.issues)).map((i) => [i.code, i.level, /^The "/.test(i.message)])), [
      ['libraryDirGecersiz', 'warn', true], ['exportAlanGecersiz', 'warn', true]
    ]);
  } finally { rmrf(d); }
});

/** Summary: Verilen içerikle geçici bir pp.config.json klasörü kurar. */
function configDir(content) {
  const d = tmpDir();
  if (content !== undefined) fs.writeFileSync(ppConfig.configFileAt(d), content);
  return d;
}

test('pp-config: inspectConfigAt iletileri okunduğu dilde üretilir (bir dilde inspect, öbüründe okuma)', async () => {
  const cases = [
    ['null', /\(kök bir nesne değil, null\)/, /\(the root is not an object, found: null\)/],
    ['[]', /\(kök bir nesne değil, dizi\)/, /\(the root is not an object, found: array\)/],
    ['5', /\(kök bir nesne değil, sayı\)/, /\(the root is not an object, found: number\)/],
    ['"x"', /\(kök bir nesne değil, metin\)/, /\(the root is not an object, found: string\)/],
    ['true', /\(kök bir nesne değil, mantıksal değer\)/, /\(the root is not an object, found: boolean\)/],
    ['garip{', /\(JSON biçimi geçersiz: .+\)\. Geçici olarak varsayılan ayarlar kullanılıyor ve yazma işlemleri kapalı\. Dosyayı düzelt \(Teknik dosyalar bölümünden açabilirsin\), sonra yeniden dene\.$/,
      /\(invalid JSON format: .+\)\. Default settings are used temporarily and write operations are disabled\. Fix the file \(you can open it from the Technical files section\), then try again\.$/]
  ];
  for (const [raw, wantTr, wantEn] of cases) {
    const d = configDir(raw);
    try {
      const r = await inTr(() => ppConfig.inspectConfigAt(d));
      assert.equal(r.issues.length, 1, raw);
      const issue = r.issues[0];
      assert.deepEqual(Object.keys(issue), ['code', 'level', 'message']);
      assert.equal(issue.code, 'ppConfigBozuk'); assert.equal(issue.level, 'warn');
      assert.match(inTr(() => issue.message), wantTr, raw);
      assert.match(inEn(() => issue.message), wantEn, raw);
      assert.match(inTr(() => issue.message), wantTr, raw + ' (tekrar tr)');
      const spread = inEn(() => ({ ...issue }));
      assert.match(spread.message, wantEn, raw + ' spread');
      assert.match(inEn(() => JSON.parse(JSON.stringify(r.issues))[0].message), wantEn, raw + ' json');
    } finally { rmrf(d); }
  }
  const d = configDir('garip{');
  try {
    const issue = (await inTr(() => ppConfig.inspectConfigAt(d))).issues[0];
    const detailTr = /JSON biçimi geçersiz: (.+)\)\. Geçici/.exec(inTr(() => issue.message))[1];
    const detailEn = /invalid JSON format: (.+)\)\. Default/.exec(inEn(() => issue.message))[1];
    assert.ok(detailTr.length > 0);
    assert.equal(detailEn, detailTr, 'motor ayrıntısı çevrilmeden parametre olarak görünür');
  } finally { rmrf(d); }
});

test('pp-config: okunamayan dosya, libraryDir ve export iletileri iki dilde', async () => {
  const d = tmpDir();
  try {
    fs.mkdirSync(ppConfig.configFileAt(d));
    const r = await inTr(() => ppConfig.inspectConfigAt(d));
    assert.match(inTr(() => r.issues[0].message), /^pp\.config\.json okunamadı \(dosya okunamadı \(E[A-Z]+\)\)\./);
    assert.match(inEn(() => r.issues[0].message), /^pp\.config\.json could not be read \(the file could not be read \(E[A-Z]+\)\)\./);
    fs.rmdirSync(ppConfig.configFileAt(d));

    const put = (o) => fs.writeFileSync(ppConfig.configFileAt(d), JSON.stringify(o));
    put({ libraryDir: '../disari' });
    let issue = (await inEn(() => ppConfig.inspectConfigAt(d))).issues[0];
    assert.equal(inTr(() => issue.message),
      'pp.config.json içindeki "libraryDir" geçersiz (".." içeremez). Geçici olarak "library" kullanılıyor ve yazma işlemleri kapalı. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin), sonra yeniden dene.');
    assert.equal(inEn(() => issue.message),
      'The "libraryDir" value in pp.config.json is invalid (cannot contain ".."). "library" is used temporarily and write operations are disabled. Fix the file (you can open it from the Technical files section), then try again.');
    put({ libraryDir: 5 });
    issue = (await inEn(() => ppConfig.inspectConfigAt(d))).issues[0];
    assert.match(inTr(() => issue.message), /geçersiz \(metin olmalı\)/);
    assert.match(inEn(() => issue.message), /is invalid \(must be text\)/);
    put({ libraryDir: 'a/plugins' });
    issue = (await inTr(() => ppConfig.inspectConfigAt(d))).issues[0];
    assert.match(inTr(() => issue.message), /geçersiz \("plugins" adı ayrılmış\)/);
    assert.match(inEn(() => issue.message), /is invalid \("plugins" is a reserved name\)/);

    put({ export: 5 });
    issue = (await inTr(() => ppConfig.inspectConfigAt(d))).issues[0];
    assert.equal(inTr(() => issue.message),
      'pp.config.json içindeki "export" nesne olmalı (şu an: sayı). Dışa aktarma için varsayılanlar kullanılıyor: durumlar ["kararlı",""], haricKlasorler ["gelen-kutusu"]. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin).');
    assert.equal(inEn(() => issue.message),
      'The "export" value in pp.config.json must be an object (currently: number). Defaults are used for export: durumlar ["kararlı",""], haricKlasorler ["gelen-kutusu"]. Fix the file (you can open it from the Technical files section).');
    put({ export: { durumlar: null, haricKlasorler: {} } });
    const both = (await inEn(() => ppConfig.inspectConfigAt(d))).issues;
    assert.deepEqual(both.map((i) => i.code), ['exportAlanGecersiz', 'exportAlanGecersiz']);
    assert.equal(inTr(() => both[0].message),
      'pp.config.json içindeki "export.durumlar" dizi olmalı (şu an: null). Bu alan için varsayılan kullanılıyor: ["kararlı",""]. Dosyayı düzelt (Teknik dosyalar bölümünden açabilirsin).');
    assert.equal(inEn(() => both[1].message),
      'The "export.haricKlasorler" value in pp.config.json must be an array (currently: object). The default is used for this field: ["gelen-kutusu"]. Fix the file (you can open it from the Technical files section).');
    assert.match(inTr(() => both[1].message), /\(şu an: nesne\)/);
  } finally { rmrf(d); }
});

test('pp-config: kök dışına çıkan bağlantı iletisi iki dilde', async (t) => {
  const d = tmpDir(); const out = tmpDir();
  const link = path.join(d, 'prompts');
  try {
    if (!makeLink(out, link)) return t.skip('bağlantı kurulamadı (EPERM)');
    fs.writeFileSync(ppConfig.configFileAt(d), JSON.stringify({ libraryDir: 'prompts' }));
    const issue = (await inEn(() => ppConfig.inspectConfigAt(d))).issues[0];
    assert.equal(issue.code, 'libraryDirGecersiz');
    assert.match(inTr(() => issue.message), /geçersiz \(marketplace klasörünün dışına çıkıyor \(bir bağlantı olabilir\)\)/);
    assert.match(inEn(() => issue.message), /is invalid \(points outside the marketplace folder \(it may be a link\)\)/);
  } finally { removeLink(link); rmrf(d); rmrf(out); }
});

test('pp-config: PpConfigError iletisi fırlatıldığı istek dilinde, kod ve durum sabit', async () => {
  const d = configDir('garip{');
  try {
    const noWrite = async () => { throw new Error('yazılmamalıydı'); };
    const errEn = await inEn(() => ppConfig.saveConfigAt(d, {}, noWrite).then(() => assert.fail('fırlatmadı'), (e) => e));
    assert.ok(errEn instanceof ppConfig.PpConfigError);
    assert.equal(errEn.status, 409); assert.deepEqual(errEn.data, { code: 'ppConfigBozuk' });
    assert.match(errEn.message, /^pp\.config\.json could not be read \(invalid JSON format: /);
    const errTr = await inTr(() => ppConfig.assertHealthy(d).then(() => assert.fail('fırlatmadı'), (e) => e));
    assert.match(errTr.message, /^pp\.config\.json okunamadı \(JSON biçimi geçersiz: /);
    fs.writeFileSync(ppConfig.configFileAt(d), JSON.stringify({ libraryDir: '' }));
    const dirEn = await inEn(() => ppConfig.assertHealthy(d).then(() => assert.fail('fırlatmadı'), (e) => e));
    assert.equal(dirEn.data.code, 'libraryDirGecersiz');
    assert.match(dirEn.message, /is invalid \(cannot be empty\)/);
  } finally { rmrf(d); }
});

test('registry: reason tembel alıcı, reasonCode sabit; önbelleğe alınmış sonuç iki dilde doğru okunur', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const tool = path.join(lib, 'arac'); fs.mkdirSync(tool);
    for (const n of ['ust', 'yok', 'bos', 'ayrintisiz', 'iyi']) fs.mkdirSync(path.join(lib, n, '.git'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'duz'));
    const answers = {
      ust: { path: lib, error: null },
      yok: { path: null, error: 'fatal: ilk satir\nikinci satir' },
      bos: emptyResponseInfo(),
      ayrintisiz: { path: null, error: null },
      iyi: { path: path.join(lib, 'iyi'), error: null }
    };
    const reg = new MarketplaceRegistry({ git: stubGit({ toplevelInfo: async (dir) => answers[path.basename(dir)] }), toolRoot: tool });
    const res = await inEn(() => reg.discover(lib, 'iyi'));
    const want = {
      ust: { code: 'kokDepoDegil', tr: 'Git deposu kökü bu klasör değil', en: 'The git repository root is not this folder' },
      yok: { code: 'gitOkunamadi', tr: 'Git deposu okunamadı: fatal: ilk satir', en: 'The git repository could not be read: fatal: ilk satir' },
      bos: { code: 'gitOkunamadi', tr: 'Git deposu okunamadı: Boş yanıt', en: 'The git repository could not be read: Empty response' },
      ayrintisiz: { code: 'gitOkunamadi', tr: 'Git deposu okunamadı', en: 'The git repository could not be read' },
      iyi: { code: null, tr: null, en: null }
    };
    const desc = Object.getOwnPropertyDescriptor(res.items[0], 'reason');
    assert.equal(typeof desc.get, 'function'); assert.equal(desc.enumerable, true);
    for (const run of [inTr, inEn, inTr, inEn]) {
      const lang = run === inTr ? 'tr' : 'en';
      for (const item of res.items) {
        assert.equal(item.reasonCode, want[item.name].code, item.name);
        assert.equal(run(() => item.reason), want[item.name][lang], item.name + ' ' + lang);
        assert.equal(run(() => ({ ...item }).reason), want[item.name][lang], item.name + ' spread ' + lang);
        assert.equal(run(() => JSON.parse(JSON.stringify(item)).reason), want[item.name][lang], item.name + ' json ' + lang);
      }
      const ignored = Object.fromEntries(res.ignored.map((i) => [i.name, [i.reasonCode, run(() => i.reason)]]));
      assert.deepEqual(ignored, {
        arac: ['aracReposu', lang === 'tr' ? 'Araç reposu' : 'Tool repository'],
        duz: ['gitDegil', lang === 'tr' ? 'Git deposu değil' : 'Not a git repository']
      });
    }
    assert.equal(res.items.find((i) => i.name === 'iyi').valid, true);
    assert.deepEqual(Object.keys(res.items[0]), ['name', 'path', 'valid', 'reason', 'reasonCode', 'active', 'hasManifest', 'hasPpConfig']);
  } finally { rmrf(d); }
});

test('registry: GitService boş yanıtı (errorCode) iki dilde; toplevelInfo sonucu deepEqual ile değişmez', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(path.join(lib, 'm', '.git'), { recursive: true });
    const git = new GitService({ runner: (bin, args, opts, cb) => cb(null, '\n', '') });
    const reg = new MarketplaceRegistry({ git, toolRoot: path.join(d, 'arac') });
    const info = await inEn(() => git.toplevelInfo(path.join(lib, 'm')));
    assert.deepEqual(info, { path: null, error: 'Empty response' });
    assert.deepEqual(Object.keys(info), ['path', 'error']);
    const res = await inTr(() => reg.discover(lib, ''));
    assert.equal(inTr(() => res.items[0].reason), 'Git deposu okunamadı: Boş yanıt');
    assert.equal(inEn(() => res.items[0].reason), 'The git repository could not be read: Empty response');
  } finally { rmrf(d); }
});

test('library-catalog: 3 sn discover önbelleği dil sızdırmaz (aynı örnek önce tr sonra en)', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const tool = path.join(lib, 'arac'); fs.mkdirSync(tool);
    for (const n of ['bozuk', 'ust', 'iyi']) fs.mkdirSync(path.join(lib, n, '.git'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'duz'));
    fs.writeFileSync(path.join(lib, 'iyi', 'pp.config.json'), JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'iyi', plugin: 'iyi' } }));
    fs.mkdirSync(path.join(lib, 'iyi', 'prompts', 'Kod İnceleme'), { recursive: true });
    fs.mkdirSync(path.join(lib, 'iyi', 'prompts', 'claude-x'), { recursive: true });
    const answers = {
      bozuk: { path: null, error: 'fatal: kötü' },
      ust: { path: lib, error: null },
      iyi: { path: path.join(lib, 'iyi'), error: null }
    };
    let calls = 0;
    const git = stubGit({ toplevelInfo: async (dir) => { calls++; return answers[path.basename(dir)]; } });
    const registry = new MarketplaceRegistry({ git, toolRoot: tool });
    const catalog = new LibraryCatalog({
      registry, index: {}, loadConfigAt: ppConfig.loadConfigAt, versions: { statusMap: async () => new Map() },
      Rules, FM, ignore: IGNORE, editable: EDITABLE, ttlMs: 600000
    });
    const shape = (tree) => ({
      ignored: tree.ignored,
      reasons: Object.fromEntries(tree.marketplaces.map((m) => [m.name, m.reason])),
      issues: Object.fromEntries(tree.marketplaces.find((m) => m.name === 'iyi').plugins.map((p) => [p.name, p.nameIssue]))
    });
    const trTree = await inTr(() => catalog.tree(lib, 'iyi'));
    const afterFirst = calls;
    const enTree = await inEn(() => catalog.tree(lib, 'iyi'));
    const trAgain = await inTr(() => catalog.tree(lib, 'iyi'));
    assert.equal(calls, afterFirst, 'ikinci ve üçüncü okuma discover önbelleğinden');
    assert.equal(trTree.marketplaces.find((m) => m.name === 'iyi').state, 'hazir');
    assert.deepEqual(shape(trTree), {
      ignored: [{ name: 'duz', reason: 'Git deposu değil' }],
      reasons: { bozuk: 'Git deposu okunamadı: fatal: kötü', iyi: null, ust: 'Git deposu kökü bu klasör değil' },
      issues: {
        'claude-x': { level: 'error', message: shape(trTree).issues['claude-x'].message },
        'Kod İnceleme': { level: 'info', message: 'Yayın adı: kod-inceleme' }
      }
    });
    assert.match(shape(trTree).issues['claude-x'].message, /Anthropic'e ayrılmış/);
    assert.deepEqual(shape(enTree), {
      ignored: [{ name: 'duz', reason: 'Not a git repository' }],
      reasons: { bozuk: 'The git repository could not be read: fatal: kötü', iyi: null, ust: 'The git repository root is not this folder' },
      issues: {
        'claude-x': { level: 'error', message: shape(enTree).issues['claude-x'].message },
        'Kod İnceleme': { level: 'info', message: 'Publish name: kod-inceleme' }
      }
    });
    assert.match(shape(enTree).issues['claude-x'].message, /is reserved for Anthropic/);
    assert.deepEqual(shape(trAgain), shape(trTree));
    const mpTr = await inTr(() => catalog.marketplaces(lib, 'iyi'));
    const mpEn = await inEn(() => catalog.marketplaces(lib, 'iyi'));
    assert.deepEqual(mpTr.ignored.map((i) => [i.name, i.reason]), [['duz', 'Git deposu değil']]);
    assert.deepEqual(mpEn.ignored.map((i) => [i.name, i.reason]), [['duz', 'Not a git repository']]);
    assert.deepEqual(mpEn.items.map((i) => [i.name, i.reasonCode, i.reason]), [
      ['bozuk', 'gitOkunamadi', 'The git repository could not be read: fatal: kötü'], ['iyi', null, null],
      ['ust', 'kokDepoDegil', 'The git repository root is not this folder']
    ]);
    assert.equal(calls, afterFirst);
  } finally { rmrf(d); }
});

/** Summary: Yalnızca saplama git ile MarketplaceFactory kurar. */
function stubFactory(git) {
  return new MarketplaceFactory({ git, templates });
}

/** Summary: Bir sözün reddedilme hatasını döner (çözülürse test başarısız olur). */
async function rejected(promise) {
  try { await promise; } catch (e) { return e; }
  return assert.fail('söz reddedilmedi');
}

test('factory: ad doğrulama, klasör var, oluşturma ve git başlatma hataları iki dilde', async () => {
  const d = tmpDir();
  try {
    const failing = { async init(dir) { fs.mkdirSync(path.join(dir, '.git')); throw new Error('init patladı'); } };
    const factory = stubFactory(failing);
    fs.mkdirSync(path.join(d, 'var'));
    const check = async (make, status, want, code) => {
      for (const [run, lang] of [[inTr, 'tr'], [inEn, 'en'], [inTr, 'tr']]) {
        const e = await run(() => rejected(make()));
        assert.equal(e.status, status, want.en);
        assert.equal(e.message, want[lang], lang);
        if (code) assert.equal(e.code, code);
      }
    };
    for (const [run, lang] of [[inTr, 'tr'], [inEn, 'en']]) {
      const e = run(() => { try { MarketplaceFactory.validateName('!!!'); } catch (err) { return err; } return null; });
      assert.equal(e.message, lang === 'tr' ? 'Geçersiz marketplace adı' : 'Invalid marketplace name');
      const dot = run(() => { try { MarketplaceFactory.validateName('ok.'); } catch (err) { return err; } return null; });
      assert.equal(dot.message, lang === 'tr' ? 'Marketplace adı nokta ile bitemez: ok.' : 'Marketplace name cannot end with a dot: ok.');
      assert.equal(dot.status, 400);
    }
    await check(() => factory.create(d, { name: 'var' }), 409, { tr: 'Bu adda bir klasör zaten var: var', en: 'A folder with this name already exists: var' });
    await check(() => factory.create(d, { name: 'yeni' }), 500, {
      tr: 'Marketplace oluşturulamadı: init patladı. Yapılan değişiklikler geri alındı.',
      en: 'Could not create the marketplace: init patladı. The changes were rolled back.'
    });
    assert.equal(fs.existsSync(path.join(d, 'yeni')), false, 'geri alındı');
    await check(() => factory.initExisting(path.join(d, 'yok')), 404, { tr: 'Klasör bulunamadı: yok', en: 'Folder not found: yok' });
    const repo = path.join(d, 'r'); fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    await check(() => factory.initExisting(repo), 409, { tr: 'Bu klasör zaten bir git deposu: r', en: 'This folder is already a git repository: r' });
    const plain = path.join(d, 'duz'); fs.mkdirSync(plain);
    await check(() => factory.initExisting(plain), 500, {
      tr: 'Git başlatılamadı: init patladı. Yapılan değişiklikler geri alındı.',
      en: 'Could not initialize git: init patladı. The changes were rolled back.'
    });
  } finally { rmrf(d); }
});

test('factory: cloneRemote hataları ve uyarıları iki dilde', async () => {
  const d = tmpDir();
  try {
    const lib = path.join(d, 'lib'); fs.mkdirSync(lib);
    const url = 'https://example.com/o/r.git';
    fs.mkdirSync(path.join(lib, 'r'));
    const exists = stubFactory({});
    for (const [run, lang] of [[inTr, 'tr'], [inEn, 'en']]) {
      const e = await run(() => rejected(exists.cloneRemote(lib, url, {})));
      assert.equal(e.status, 409); assert.equal(e.code, 'klasorVar');
      assert.equal(e.message, lang === 'tr' ? 'Bu adda bir klasör zaten var: r' : 'A folder with this name already exists: r');
    }
    fs.rmdirSync(path.join(lib, 'r'));

    const netFail = stubFactory({ clone: async () => { const e = new Error('x'); e.netCode = 'ag'; throw e; } });
    const netEn = await inEn(() => rejected(netFail.cloneRemote(lib, url, {})));
    assert.equal(netEn.status, 502); assert.equal(netEn.code, 'ag');
    assert.equal(netEn.message, 'Could not clone the repository: Could not reach the remote. Check your network connection and the URL.');
    const netTr = await inTr(() => rejected(netFail.cloneRemote(lib, url, {})));
    assert.equal(netTr.message, "Depo klonlanamadı: Uzak depoya ulaşılamadı. Ağ bağlantısını ve URL'yi kontrol et.");

    const notRoot = stubFactory({ clone: async (root, u, slug) => fs.mkdirSync(path.join(root, slug)), isRepoRoot: async () => false });
    const rootEn = await inEn(() => rejected(notRoot.cloneRemote(lib, url, {})));
    assert.equal(rootEn.status, 502); assert.equal(rootEn.code, 'bilinmiyor');
    assert.equal(rootEn.detail, 'The cloned folder is not a git repository root');
    const rootTr = await inTr(() => rejected(notRoot.cloneRemote(lib, url, {})));
    assert.equal(rootTr.detail, 'Klonlanan klasör bir git deposu kökü değil');
    assert.equal(fs.existsSync(path.join(lib, 'r')), false, 'yarım klasör silindi');

    const empty = stubFactory({ clone: async (root, u, slug) => fs.mkdirSync(path.join(root, slug)), isRepoRoot: async () => true, hasCommits: async () => false });
    const en = await inEn(() => empty.cloneRemote(lib, url, {}));
    assert.deepEqual(en.warnings, [
      { code: 'ppConfigYok', message: 'This repository has no pp.config.json. Create the Prompt Havuzu settings.' },
      { code: 'manifestYok', message: '.claude-plugin/marketplace.json is missing.' },
      { code: 'bosDepo', message: 'The repository is empty (no commits yet).' }
    ]);
    fs.rmSync(path.join(lib, 'r'), { recursive: true, force: true });
    const tr = await inTr(() => empty.cloneRemote(lib, url, {}));
    assert.deepEqual(tr.warnings, [
      { code: 'ppConfigYok', message: 'Bu depoda pp.config.json yok. Prompt Havuzu ayarlarını oluştur.' },
      { code: 'manifestYok', message: '.claude-plugin/marketplace.json yok.' },
      { code: 'bosDepo', message: 'Depo boş (henüz commit yok).' }
    ]);
  } finally { rmrf(d); }
});

const atomicWrite = async (abs, data) => { const t = abs + '.tmp'; await fsp.writeFile(t, data, 'utf8'); await fsp.rename(t, abs); };

/** Summary: PackageService için geçici marketplace kurar (prompts/eski klasörü ve eski paket açıklaması hazır). */
function buildPackages(over = {}) {
  const d = tmpDir();
  const cfgFile = path.join(d, 'pp.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ libraryDir: 'prompts', marketplace: { name: 'm', plugin: 'm' }, packages: { eski: { description: 'Eski aciklama' } } }, null, 2) + '\n');
  fs.mkdirSync(path.join(d, 'prompts', 'eski'), { recursive: true });
  fs.writeFileSync(path.join(d, 'prompts', 'eski', 'a.md'), 'a');
  const svc = new PackageService({
    fsp, atomicWrite, loadConfigAt: ppConfig.loadConfigAt, saveConfigAt: ppConfig.saveConfigAt, Rules, FM, ...over
  });
  return { d, svc, cfgFile };
}

test('package-service: doğrulama ve çakışma hataları iki dilde, durum kodları sabit', async () => {
  const { d, svc } = buildPackages();
  try {
    const check = async (make, status, want) => {
      for (const [run, lang] of [[inTr, 'tr'], [inEn, 'en'], [inTr, 'tr']]) {
        const e = await run(() => rejected(make()));
        assert.ok(e instanceof PackageError);
        assert.equal(e.status, status, want.en);
        assert.equal(e.message, want[lang], lang);
      }
    };
    await check(() => svc.create(d, 'prompts', { name: '   ' }), 400, { tr: 'Plugin adı gerekli', en: 'Plugin name is required' });
    await check(() => svc.create(d, 'prompts', { name: 'eski' }), 409, { tr: 'Bu adda bir plugin zaten var: eski', en: 'A plugin with this name already exists: eski' });
    await check(() => svc.rename(d, 'prompts', { from: 'yok', to: 'yeni' }), 404, { tr: 'Plugin bulunamadı: yok', en: 'Plugin not found: yok' });
    await check(() => svc.rename(d, 'prompts', { from: 'eski', to: 'eski' }), 400, { tr: 'Yeni ad eskisiyle aynı', en: 'The new name is the same as the old one' });
    await check(() => svc.setDescription(d, 'prompts', { name: 'yok', description: 'x' }), 404, { tr: 'Plugin bulunamadı: yok', en: 'Plugin not found: yok' });
    await check(() => svc.setDescription(d, 'prompts', { name: 'eski', description: ' ' }), 400, {
      tr: 'Paket açıklaması boş olamaz', en: 'The package description cannot be empty'
    });
    const reserved = await inEn(() => rejected(svc.create(d, 'prompts', { name: 'claude-x' })));
    assert.equal(reserved.status, 400);
    assert.match(reserved.message, /is reserved for Anthropic/);
  } finally { rmrf(d); }
});

test('package-service: geri alınan işlem iletisi işleme göre ve dile göre; geri alma başarısızlığı; bozuk ayar aynen geçer', async () => {
  const failing = { saveConfigAt: async () => { throw new Error('yazılamadı'); } };
  const a = buildPackages(failing);
  try {
    const en = await inEn(() => rejected(a.svc.create(a.d, 'prompts', { name: 'yeni', description: 'a' })));
    assert.equal(en.status, 500);
    assert.equal(en.message, 'Could not create the plugin: yazılamadı. The changes were rolled back.');
    const tr = await inTr(() => rejected(a.svc.create(a.d, 'prompts', { name: 'yeni', description: 'a' })));
    assert.equal(tr.message, 'Plugin oluşturulamadı: yazılamadı. Yapılan değişiklikler geri alındı.');
  } finally { rmrf(a.d); }
  const b = buildPackages(failing);
  try {
    const en = await inEn(() => rejected(b.svc.rename(b.d, 'prompts', { from: 'eski', to: 'yeni' })));
    assert.equal(en.message, 'Could not rename the plugin: yazılamadı. The changes were rolled back.');
    assert.equal(en.data, undefined);
    const tr = await inTr(() => rejected(b.svc.rename(b.d, 'prompts', { from: 'eski', to: 'yeni' })));
    assert.equal(tr.message, 'Plugin yeniden adlandırılamadı: yazılamadı. Yapılan değişiklikler geri alındı.');
  } finally { rmrf(b.d); }
  let renames = 0;
  const flaky = { ...fsp, rename: async (x, y) => { renames++; if (renames > 1) throw new Error('geri alinamadi'); return fsp.rename(x, y); } };
  const c = buildPackages({ fsp: flaky, saveConfigAt: async () => { throw new Error('yazılamadı'); } });
  try {
    const en = await inEn(() => rejected(c.svc.rename(c.d, 'prompts', { from: 'eski', to: 'yeni' })));
    assert.equal(en.message, 'The plugin operation failed and the rollback could not be completed: geri alinamadi. Check the folder manually.');
    assert.deepEqual(en.data, { rollbackFailed: true });
  } finally { rmrf(c.d); }
  const e = buildPackages({ assertHealthy: ppConfig.assertHealthy });
  try {
    fs.writeFileSync(e.cfgFile, 'garip{');
    const en = await inEn(() => rejected(e.svc.create(e.d, 'prompts', { name: 'yeni' })));
    assert.ok(en instanceof ppConfig.PpConfigError);
    assert.equal(en.status, 409); assert.equal(en.data.code, 'ppConfigBozuk');
    assert.match(en.message, /^pp\.config\.json could not be read/);
  } finally { rmrf(e.d); }
});

test('package-catalog: sorun ve atlama iletileri iki dilde (tur başına tam cümle), kod ve düzey sabit', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    write(mk, 'prompts/ornek/aj.md', '---\nbaslik: Aj\ntur: ajan\nkomut_adi: aj\n---\ngövde\n');
    write(mk, 'prompts/ornek/sk.md', '---\nbaslik: Sk\ntur: skill\nkomut_adi: sk\n---\ngövde\n');
    write(mk, 'prompts/ornek/bos.md', '---\nbaslik: Bos\ntur: komut\nkomut_adi: bos\naciklama: var\n---\n');
    write(mk, 'prompts/ornek/c1.md', cmd('C1', 'komut_adi: cc\naciklama: x\n'));
    write(mk, 'prompts/ornek/c2.md', cmd('C2', 'komut_adi: cc\naciklama: y\n'));
    write(mk, 'prompts/gelen-kutusu/g.md', cmd('G'));
    const s = buildStack(mk, tmp);
    const cfg = await s.config.load();
    const rows = (built) => {
      const out = {};
      for (const p of built.plans) out[p.source] = p.issues.map((i) => [i.code, i.level, i.msg]);
      return out;
    };
    const trBuilt = await inTr(() => s.catalog.build(cfg));
    const enBuilt = await inEn(() => s.catalog.build(cfg));
    const trRows = rows(trBuilt); const enRows = rows(enBuilt);
    assert.deepEqual(trRows['prompts/ornek/a.md'], [['aciklamaBos', 'info', 'Açıklama boş, başlık kullanılacak']]);
    assert.deepEqual(enRows['prompts/ornek/a.md'], [['aciklamaBos', 'info', 'Description is empty, the title will be used']]);
    assert.deepEqual(trRows['prompts/ornek/aj.md'], [['aciklamaBos', 'warn', 'Açıklama boş. Claude, bu ajanı ne zaman kullanacağını açıklamadan seçer']]);
    assert.deepEqual(enRows['prompts/ornek/aj.md'], [['aciklamaBos', 'warn', 'Description is empty. Claude decides when to use this agent based on its description']]);
    assert.deepEqual(trRows['prompts/ornek/sk.md'], [['aciklamaBos', 'warn', "Açıklama boş. Claude, bu skill'i ne zaman kullanacağını açıklamadan seçer"]]);
    assert.deepEqual(enRows['prompts/ornek/sk.md'], [['aciklamaBos', 'warn', 'Description is empty. Claude decides when to use this skill based on its description']]);
    assert.deepEqual(trRows['prompts/ornek/bos.md'], [['icerikBos', 'error', 'İçerik boş']]);
    assert.deepEqual(enRows['prompts/ornek/bos.md'], [['icerikBos', 'error', 'Content is empty']]);
    for (const src of ['prompts/ornek/c1.md', 'prompts/ornek/c2.md']) {
      assert.deepEqual(trRows[src], [['hedefCakisiyor', 'error', 'Aynı hedef dosya birden fazla prompt tarafından kullanılıyor: plugins/ornek/commands/cc.md']]);
      assert.deepEqual(enRows[src], [['hedefCakisiyor', 'error', 'The same target file is used by more than one prompt: plugins/ornek/commands/cc.md']]);
    }
    const skipTr = trBuilt.bySkipped.get('prompts/gelen-kutusu/g.md');
    const skipEn = enBuilt.bySkipped.get('prompts/gelen-kutusu/g.md');
    assert.deepEqual([skipTr.code, skipTr.level], ['paketDisiKlasor', 'info']);
    assert.equal(skipTr.reason, 'Bu klasör bir pakete dahil değil (gelen kutusu ya da hariç tutulan klasör).');
    assert.equal(skipEn.reason, 'This folder is not part of a package (Inbox or an excluded folder).');
    assert.deepEqual(enBuilt.plans.map((p) => [p.source, p.target, p.state]), trBuilt.plans.map((p) => [p.source, p.target, p.state]), 'plan dilden bağımsız');
    assert.deepEqual(enBuilt.plans.map((p) => p.expected), trBuilt.plans.map((p) => p.expected), 'üretilen çıktı dilden bağımsız');
  } finally { rmrf(tmp); }
});

test('version-advisor: ilk yayın, değişiklik yok, çoğul nedenler ve validateChoice iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const analyze = async (run) => {
      const cfg = await s.config.load();
      const built = await s.catalog.build(cfg);
      return run(() => s.advisor.analyze(mk, built.packages.get('ornek'), cfg));
    };
    assert.deepEqual((await analyze(inTr)).reasons, ['İlk yayın']);
    assert.deepEqual((await analyze(inEn)).reasons, ['First publish']);

    await s.publisher.publish(mk, { name: 'ornek' });
    const same = await analyze(inEn);
    assert.equal(same.noChange, true);
    assert.deepEqual(same.reasons, ['No changes since the last publish']);
    assert.deepEqual((await analyze(inTr)).reasons, ['Son yayından beri değişiklik yok']);
    assert.equal(inTr(() => s.advisor.validateChoice(same, '1.0.1').message), 'Son yayından beri değişiklik yok, yayınlanacak bir şey yok');
    assert.equal(inEn(() => s.advisor.validateChoice(same, '1.0.1').message), 'No changes since the last publish, so there is nothing to publish');
    assert.equal(inEn(() => s.advisor.validateChoice(same, '1.0.1').code), 'degisiklikYok');

    write(mk, 'prompts/ornek/c.md', cmd('C'));
    commitAll(mk, tmp);
    assert.deepEqual((await analyze(inTr)).reasons, ['1 yeni dosya']);
    assert.deepEqual((await analyze(inEn)).reasons, ['1 new file']);

    write(mk, 'prompts/ornek/d.md', cmd('D'));
    write(mk, 'prompts/ornek/a.md', '---\nbaslik: A\ntur: komut\nkomut_adi: aa\n---\nDEGISTI\n');
    fs.rmSync(path.join(mk, 'prompts', 'ornek', 'b.md'));
    commitAll(mk, tmp);
    const tr = await analyze(inTr);
    const en = await analyze(inEn);
    assert.deepEqual(tr.reasons, ['2 yeni dosya', '1 değişen dosya', '1 kaldırılan dosya']);
    assert.deepEqual(en.reasons, ['2 new files', '1 changed file', '1 removed file']);
    assert.deepEqual([en.level, en.version, tr.level, tr.version], ['buyuk', '2.0.0', 'buyuk', '2.0.0']);
    assert.equal(inTr(() => s.advisor.validateChoice(tr, '1.0.0').message), 'Sürüm son yayından (1.0.0) büyük olmalı');
    assert.equal(inEn(() => s.advisor.validateChoice(en, '1.0.0').message), 'The version must be greater than the last published version (1.0.0)');
    assert.equal(inEn(() => s.advisor.validateChoice(en, '1.0.0').code), 'surumGeride');
    const bumped = (a) => a.prompts.find((p) => p.ad === 'aa').issues.find((i) => i.code === 'surumArtirilmamis');
    assert.equal(bumped(tr).msg, 'İçerik değişmiş ama "versiyon" artırılmamış ((boş)). Yama sayılacak.');
    assert.equal(bumped(en).msg, 'The content has changed but "versiyon" was not bumped ((empty)). It will be counted as a patch.');
  } finally { rmrf(tmp); }
});

test('version-advisor: yalnızca etiket (tagOnly) ve sürüm üst sınırı nedenleri iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    const cfg = await s.config.load();
    const built = await s.catalog.build(cfg);
    const undo = new UndoStack();
    await s.exporter.apply(s.exporter.plan('ornek', built.packages.get('ornek').prompts, built.scanned), undo);
    await s.manifests.writePluginJson('ornek', cfg, { version: '1.0.1' }, undo);
    undo.clear();
    commitAll(mk, tmp);
    const analyze = async (run) => {
      const c = await s.config.load();
      const b = await s.catalog.build(c);
      return run(() => s.advisor.analyze(mk, b.packages.get('ornek'), c));
    };
    const tagOnly = await analyze(inEn);
    assert.equal(tagOnly.tagOnly, true);
    assert.deepEqual(tagOnly.reasons, ['The output is the same as HEAD, only a tag will be created']);
    assert.deepEqual((await analyze(inTr)).reasons, ['Çıktı HEAD ile aynı, yalnızca etiket atılacak']);
  } finally { rmrf(tmp); }
});

test('version-advisor: sürüm üst sınırı nedeni iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek', version: '1.1.999999999' });
    write(mk, 'prompts/ornek/a.md', '---\nbaslik: A\ntur: komut\nkomut_adi: aa\n---\nDEGISTI\n');
    commitAll(mk, tmp);
    const analyze = async (run) => {
      const c = await s.config.load();
      const b = await s.catalog.build(c);
      return run(() => s.advisor.analyze(mk, b.packages.get('ornek'), c));
    };
    const trTop = (await analyze(inTr)).reasons;
    const enTop = (await analyze(inEn)).reasons;
    assert.deepEqual(trTop, ['1 değişen dosya', 'Sürüm üst sınıra ulaştı; yeni sürümü elle belirle']);
    assert.deepEqual(enTop, ['1 changed file', 'The version reached the upper limit; set the new version manually']);
  } finally { rmrf(tmp); }
});

test('version-advisor: paket açıklaması değişti nedeni iki dilde', real, async () => {
  const tmp = tmpDir();
  try {
    const mk = seed(tmp);
    const s = buildStack(mk, tmp);
    await s.publisher.publish(mk, { name: 'ornek' });
    const cfgFile = path.join(mk, 'pp.config.json');
    const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); c.packages.ornek.description = 'Yeni açıklama';
    fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2) + '\n');
    commitAll(mk, tmp);
    const cfg = await s.config.load();
    const built = await s.catalog.build(cfg);
    const tr = await inTr(() => s.advisor.analyze(mk, built.packages.get('ornek'), cfg));
    const en = await inEn(() => s.advisor.analyze(mk, built.packages.get('ornek'), cfg));
    assert.deepEqual(tr.reasons, ['Paket açıklaması değişti']);
    assert.deepEqual(en.reasons, ['Package description changed']);
  } finally { rmrf(tmp); }
});

test('sözlük: setup.*, cfg.*, mp.*, pkg.*, ver.adv.* anahtar kümesi, yer tutucular ve çoğul kategorileri tr ve en için eşit', () => {
  const keys = stageKeys(TR);
  assert.deepEqual(stageKeys(EN), keys);
  assert.deepEqual(keys, EXPECTED_KEYS);
  for (const ns of NAMESPACES) assert.ok(keys.some((key) => key.startsWith(ns)), ns);
  for (const key of [...keys, ...REUSED_RULE_KEYS]) {
    const trValue = TR[key];
    const enValue = EN[key];
    assert.ok(trValue !== undefined && enValue !== undefined, 'her iki sözlükte var ' + key);
    assert.equal(typeof trValue, typeof enValue, 'aynı biçim ' + key);
    const trVariants = variants(trValue);
    const enVariants = variants(enValue);
    const all = [...Object.values(trVariants), ...Object.values(enVariants)];
    assert.ok(all.every((text) => typeof text === 'string' && text.trim().length > 0), 'boş değer yok ' + key);
    const expected = placeholders(all[0]);
    for (const text of all) assert.deepEqual(placeholders(text), expected, 'yer tutucu kümesi ' + key + ': ' + text);
    if (typeof trValue === 'object') {
      assert.ok(expected.includes('count'), 'çoğul anahtar count ister ' + key);
      assert.deepEqual(Object.keys(trVariants), ['other'], 'tr yalnızca other ' + key);
      assert.deepEqual(Object.keys(enVariants).sort(), ['one', 'other'], 'en one + other ' + key);
    }
  }
  assert.deepEqual(placeholders(TR['setup.marketplaceGitYokNeden']), ['name', 'reason']);
  assert.deepEqual(placeholders(TR['cfg.libraryDirGecersiz']), ['fallback', 'field', 'reason']);
  assert.deepEqual(placeholders(TR['cfg.exportGecersiz']), ['defaults', 'field', 'type']);
});

test('en değerlerinde Türkçe diyakritik ve en-GB yazım yok; terim tablosuna uyum', () => {
  for (const key of stageKeys(EN)) {
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), key + ': ' + text);
      assert.doesNotMatch(text, /initialis|cancell|colour|behaviour|catalogue|organis/i, key);
    }
  }
  assert.match(EN['setup.kokAyarlanmadi'], /Library root/);
  assert.match(EN['setup.kokAyarlanmadi'], /Settings/);
  assert.match(EN['setup.marketplaceGitYok'], /Git is not initialized/);
  assert.match(EN['cfg.bozuk'], /Technical files/);
  assert.match(EN['pkg.skip.paketDisiKlasor'], /Inbox/);
});

test('kaynak taraması: sözlük anahtarları tr ve en\'de var, çevrilmemiş Türkçe dize değişmezi kalmadı, LF', () => {
  const used = new Set();
  const turkish = [];
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(LIB, file), 'utf8');
    assert.ok(!src.includes('\r'), file + ': LF');
    assert.ok(/\bI18n = require\('\.\.\/public\/i18n\.js'\)/.test(src), file + ': i18n.js kullanılıyor');
    const literals = stringLiterals(src);
    assert.ok(literals.length > 3, file + ': tarayıcı dizeleri buluyor');
    for (const text of literals) {
      if (NAMESPACES.some((ns) => text.startsWith(ns)) && /^[a-z]+(\.[A-Za-z]+)+$/.test(text)) used.add(text);
      if (DIACRITIC_RE.test(text) && !ALLOWED_TURKISH_LITERALS.includes(text)) turkish.push(file + ': ' + text);
    }
    for (const m of src.matchAll(/\btx\('([^']+)'/g)) {
      if (REUSED_RULE_KEYS.includes(m[1])) used.add(m[1]);
      else assert.ok(NAMESPACES.some((ns) => m[1].startsWith(ns)) || m[1].startsWith('git.') || m[1].startsWith('rules.'), file + ': ' + m[1]);
    }
  }
  assert.deepEqual(turkish, [], 'çevrilmemiş Türkçe dize');
  for (const key of used) {
    assert.ok(Object.prototype.hasOwnProperty.call(TR, key), 'tr: ' + key);
    assert.ok(Object.prototype.hasOwnProperty.call(EN, key), 'en: ' + key);
  }
  assert.deepEqual([...used].filter((k) => !REUSED_RULE_KEYS.includes(k)).sort(), EXPECTED_KEYS, 'kaynakta kullanılan anahtarlar = bu aşamanın anahtarları');
  for (const key of REUSED_RULE_KEYS) assert.ok(used.has(key), 'yeniden kullanılan kural anahtarı kullanılıyor: ' + key);
  assert.deepEqual(stringLiterals("a = /[\"']/; b = 'x/y'; // 'z'\nc = \"ş\"; d = x / 2; e = `t`"), ['x/y', 'ş', 't']);
});

test('eksik anahtar yok: bu dosyadaki tüm çağrılar sonunda I18n.missing bu aşamanın ad uzaylarından boş', () => {
  assert.deepEqual(I18n.missing.filter((entry) => NAMESPACES.some((ns) => entry.includes(':' + ns)) || /:rules\.(pluginAdGerekli|mpAdNokta)$/.test(entry)), []);
});
