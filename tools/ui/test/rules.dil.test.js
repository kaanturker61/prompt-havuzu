'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Rules = require('../public/rules.js');
const I18n = require('../public/i18n.js');
const TR = require('../public/lang/tr.js');
const EN = require('../public/lang/en.js');

const PUBLIC = path.join(__dirname, '..', 'public');
const RULES_SRC = fs.readFileSync(path.join(PUBLIC, 'rules.js'), 'utf8');
const DIACRITIC_RE = /[çğıöşüÇĞİÖŞÜ]/;
const PLACEHOLDER_RE = /\{([A-Za-z_]\w*)\}/g;

/** Summary: Çağrıyı İngilizce dil bağlamında çalıştırır. */
const inEn = (fn) => I18n.run('en', fn);

/** Summary: Çağrıyı Türkçe dil bağlamında çalıştırır. */
const inTr = (fn) => I18n.run('tr', fn);

/** Summary: Verilen süre sonra çözülen söz. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Summary: Sözlüğün rules.* anahtarları, sıralı. */
function ruleKeys(dictionary) {
  return Object.keys(dictionary).filter((key) => key.startsWith('rules.')).sort();
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

/** Summary: index.html betik sırasıyla beş dosyayı boş bir tarayıcı bağlamına yükler. */
function loadBrowser() {
  const ctx = vm.createContext({});
  for (const f of ['lang/tr.js', 'lang/en.js', 'i18n.js', 'fm.js', 'rules.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

/** Summary: rules.js'in dışa açtığı anahtarlar (Aşama 3 öncesiyle aynı olmalı). */
const EXPORTS = [
  'CC_FIELDS', 'CC_PLUGIN_IGNORED', 'DEFAULT_VERSION', 'INBOX_DIR', 'LEVEL_LABEL', 'LIBRARY_DIR', 'LIBRARY_DIR_RESERVED',
  'MAX_NAME_BYTES', 'MAX_URL_LENGTH', 'MSG', 'PACKAGE_TAG_PREFIX',
  'PROMPT_TAG_PREFIX', 'PUBLISH_FIELDS', 'RESERVED_DIRS', 'SEMVER_RE', 'TUR_PROMPT',
  'VERSION_LEVELS', 'VERSION_PART_MAX', 'bumpVersion', 'ccBool', 'ccFieldsFor', 'ccList', 'ccUnusedKeys', 'ccValue', 'checkEntryName',
  'checkMarketplaceName', 'checkPluginName', 'checkRemoteName', 'checkRemoteUrl',
  'checkVersion', 'classifyPromptPath', 'coerceVersion', 'compareVersions',
  'durumAllowed', 'isDeviceName', 'isFmBroken', 'isProtectedPath',
  'levelBetween', 'marketplaceAddCommand', 'maxLevel', 'migrateLegacyKeys', 'normTur',
  'normalizeRepoUrl', 'normalizeVersion', 'packageTag', 'parseLibraryDir',
  'parsePackageTag', 'parsePromptTag', 'pluginNameWarn', 'promptTag',
  'promptTagAd', 'publishCheck', 'repoProvider', 'resolvePackage', 'turOf'
];

/** Summary: [kullanılan sözlük anahtarları, çağrı, beklenen tr metni, beklenen en metni] örnekleri; her rules.* anahtarı en az bir örnekte geçer. */
const CASES = [
  [['rules.turYok'], () => Rules.MSG.turYok(['komut_adi', 'aciklama']),
    'Yayın alanları dolu (komut_adi, aciklama) ama "tur" yok. Bu prompt yayınlanmayacak.',
    'Publish fields are filled in (komut_adi, aciklama) but "tur" is missing. This prompt will not be published.'],
  [['rules.turGecersiz'], () => Rules.MSG.turGecersiz('komutt'),
    '"tur" değeri tanınmadı: "komutt". Geçerli değerler: prompt, komut, ajan, skill. Bu prompt yayınlanmayacak.',
    'The "tur" value was not recognized: "komutt". Valid values: prompt, komut, ajan, skill. This prompt will not be published.'],
  [['rules.onYuzKapanmamis'], () => Rules.MSG.onYuzKapanmamis,
    'Frontmatter kapanmamış (ikinci "---" satırı yok). Alanlar okunamıyor, bu prompt yayınlanmayacak.',
    'The frontmatter is not closed (there is no second "---" line). The fields cannot be read, so this prompt will not be published.'],
  [['rules.dosyaBuyuk'], () => Rules.MSG.dosyaBuyuk,
    'Dosya 2 MB\'tan büyük. Dizinlenmiyor ve yayınlanmıyor.',
    'The file is larger than 2 MB. It is not indexed or published.'],
  [['rules.yayinDisi'], () => Rules.MSG.yayinDisi,
    'Tür seçilmemiş (yayın dışı).',
    'No type selected (not published).'],
  [['rules.turPrompt'], () => Rules.MSG.turPrompt,
    "Prompt türü: Claude Code'a yayınlanmaz.",
    'Prompt type: not published to Claude Code.'],
  [['rules.surumGuncelDegil'], () => Rules.MSG.surumGuncelDegil('1.0.2'),
    'Son sürümden (v1.0.2) beri dosya değişti ama versiyon aynı. Yeni sürüm için +1\'e bas.',
    'The file has changed since the last version (v1.0.2) but "versiyon" is the same. Press +1 for a new version.'],
  [['rules.adUretilemedi'], () => Rules.MSG.adUretilemedi('!!!'),
    'Ad üretilemedi ("!!!"), "adsiz" kullanılacak. "Ad" alanına harf veya rakam içeren bir değer yaz.',
    'Could not generate a name ("!!!"), so "adsiz" will be used. Enter a value containing a letter or digit in the "Name" field.'],
  [['rules.paketUyusmuyor'], () => Rules.MSG.paketUyusmuyor('Kod İnceleme', 'baska'),
    'Dosya "Kod İnceleme" paketinin klasöründe ama "paket" alanı "baska". Paket klasörden alınır; alanı düzelt ya da dosyayı taşı.',
    'The file is in the folder of package "Kod İnceleme" but its "paket" field is "baska". The package is taken from the folder; fix the field or move the file.'],
  [['rules.paketCokDegerli'], () => Rules.MSG.paketCokDegerli,
    '"paket" tek bir değer olmalı.',
    '"paket" must be a single value.'],
  [['rules.durumHaric', 'rules.durumBos'], () => Rules.MSG.durumHaric('taslak', ['kararlı', '']),
    'Durumu "taslak". Yalnızca şu durumlar dışa aktarılır: kararlı, (boş).',
    'Status is "taslak". Only these statuses are exported: kararlı, (empty).'],
  [['rules.durumHaricBos'], () => Rules.MSG.durumHaric('', ['kararlı']),
    'Durumu boş. Yalnızca şu durumlar dışa aktarılır: kararlı.',
    'Status is empty. Only these statuses are exported: kararlı.'],
  [['rules.surumArtirilmamis'], () => Rules.MSG.surumArtirilmamis('1.0.2'),
    'İçerik değişmiş ama "versiyon" artırılmamış (1.0.2). Yama sayılacak.',
    'The content has changed but "versiyon" was not bumped (1.0.2). It will be counted as a patch.'],
  [['rules.anahtarTekrar'], () => Rules.MSG.anahtarTekrar([{ key: 'baslik', count: 2 }]),
    'baslik 2 kez yazılmış; sonuncusu geçerli.',
    'baslik is written 2 times; the last one is used.'],
  [['rules.anahtarTekrarCok', 'rules.anahtarTekrarOge'], () => Rules.MSG.anahtarTekrar([{ key: 'baslik', count: 2 }, { key: 'durum', count: 3 }]),
    'baslik (2 kez), durum (3 kez) birden fazla kez yazılmış; hepsinde sonuncusu geçerli.',
    'baslik (2 times), durum (3 times) are written more than once; in each case the last one is used.'],
  [['rules.aygitAdi'], () => Rules.MSG.aygitAdi('CON'),
    '"CON" bir Windows aygıt adı; dosya, klasör veya plugin adı olarak kullanılamaz. Başka bir ad seç.',
    '"CON" is a Windows device name and cannot be used as a file, folder or plugin name. Choose another name.'],
  [['rules.level.buyuk'], () => Rules.LEVEL_LABEL.buyuk,
    'Büyük',
    'Major'],
  [['rules.level.kucuk'], () => Rules.LEVEL_LABEL.kucuk,
    'Küçük',
    'Minor'],
  [['rules.level.yama'], () => Rules.LEVEL_LABEL.yama,
    'Yama',
    'Patch'],
  [['rules.surumBos'], () => Rules.checkVersion(''),
    'Sürüm boş olamaz (örnek: 1.0.0)',
    'Version cannot be empty (example: 1.0.0)'],
  [['rules.surumBasamak'], () => Rules.checkVersion('1000000000.0.0'),
    'Sürüm bileşenleri en çok 9 basamak olabilir: "1000000000.0.0"',
    'Version components can have at most 9 digits: "1000000000.0.0"'],
  [['rules.surumBicim'], () => Rules.checkVersion('1.0'),
    'Sürüm X.Y.Z biçiminde olmalı (örnek: 1.0.0): "1.0"',
    'Version must be in X.Y.Z format (example: 1.0.0): "1.0"'],
  [['rules.pluginAdGerekli'], () => Rules.checkPluginName(''),
    'Plugin adı gerekli',
    'Plugin name is required'],
  [['rules.pluginAdGelenKutusu'], () => Rules.checkPluginName('gelen-kutusu'),
    '"gelen-kutusu" içe aktarma klasörüne ayrılmış. Başka bir ad seç.',
    '"gelen-kutusu" is reserved for the import folder (Inbox). Choose another name.'],
  [['rules.pluginAdSistem'], () => Rules.checkPluginName('tools'),
    '"tools" adı sistemde ayrılmış. Başka bir ad seç.',
    '"tools" is a reserved system name. Choose another name.'],
  [['rules.pluginAdAnthropic'], () => Rules.checkPluginName('claude-x'),
    '"claude-x" adı Anthropic\'e ayrılmış (claude-, anthropic-, anthropics-, cc-plugin- ile başlayamaz; claude, anthropic, claude-code gibi adlar kullanılamaz). Başka bir ad seç.',
    '"claude-x" is reserved for Anthropic (it cannot start with claude-, anthropic-, anthropics-, cc-plugin-; names such as claude, anthropic, claude-code cannot be used). Choose another name.'],
  [['rules.pluginUyariKelime'], () => Rules.pluginNameWarn('mcp-for-claude'),
    '"mcp-for-claude" içinde "claude" kelimesi geçiyor; Claude Code bunu uyarıyla kabul eder.',
    '"mcp-for-claude" contains the word "claude"; Claude Code accepts this with a warning.'],
  [['rules.pluginUyariUzun'], () => Rules.pluginNameWarn('a'.repeat(129)),
    'Plugin adı 128 karakterden uzun; Claude Desktop kabul etmeyebilir.',
    'Plugin name is longer than 128 characters; Claude Desktop may not accept it.'],
  [['rules.adBos'], () => Rules.checkEntryName(''),
    'Ad boş olamaz',
    'Name cannot be empty'],
  [['rules.adNokta'], () => Rules.checkEntryName('..'),
    'Ad "." ya da ".." olamaz',
    'Name cannot be "." or ".."'],
  [['rules.adUzun'], () => Rules.checkEntryName('a'.repeat(250)),
    'Ad en çok 200 bayt olabilir',
    'Name can be at most 200 bytes'],
  [['rules.adKarakter'], () => Rules.checkEntryName('a?b'),
    'Ad şu karakterleri içeremez: < > : " | ? * ve kontrol karakterleri',
    'Name cannot contain these characters: < > : " | ? * and control characters'],
  [['rules.adSon'], () => Rules.checkEntryName('x.'),
    'Ad nokta ya da boşlukla bitemez',
    'Name cannot end with a dot or a space'],
  [['rules.libDirMetin'], () => Rules.parseLibraryDir(5).error,
    'metin olmalı',
    'must be text'],
  [['rules.libDirBos'], () => Rules.parseLibraryDir('').error,
    'boş olamaz',
    'cannot be empty'],
  [['rules.libDirMutlak'], () => Rules.parseLibraryDir('/etc').error,
    'mutlak yol olamaz (marketplace klasörüne göreli olmalı)',
    'cannot be an absolute path (it must be relative to the marketplace folder)'],
  [['rules.libDirKarakter'], () => Rules.parseLibraryDir('a\u0000b').error,
    'geçersiz karakter içeriyor',
    'contains an invalid character'],
  [['rules.libDirIkiNokta'], () => Rules.parseLibraryDir('a/../b').error,
    '".." içeremez',
    'cannot contain ".."'],
  [['rules.libDirBosBilesen'], () => Rules.parseLibraryDir('a//b').error,
    'boş ya da "." bileşeni içeremez',
    'cannot contain an empty or "." component'],
  [['rules.libDirNoktaBitis'], () => Rules.parseLibraryDir('x./y').error,
    'bir bileşen nokta ya da boşlukla bitemez: "x."',
    'a component cannot end with a dot or a space: "x."'],
  [['rules.libDirAyrilmis'], () => Rules.parseLibraryDir('.git').error,
    '".git" adı ayrılmış',
    '".git" is a reserved name'],
  [['rules.mpAdGerekli'], () => Rules.checkMarketplaceName(''),
    'Marketplace adı gerekli',
    'Marketplace name is required'],
  [['rules.mpAdUzun'], () => Rules.checkMarketplaceName('x'.repeat(129)),
    'Marketplace adı 128 karakterden uzun olamaz',
    'Marketplace name cannot be longer than 128 characters'],
  [['rules.mpAdBicim'], () => Rules.checkMarketplaceName('-x'),
    'Marketplace adı harf ya da rakamla başlamalı; yalnızca harf, rakam, ".", "_" ve "-" içerebilir: -x',
    'Marketplace name must start with a letter or digit and can contain only letters, digits, ".", "_" and "-": -x'],
  [['rules.mpAdNokta'], () => Rules.checkMarketplaceName('ok.'),
    'Marketplace adı nokta ile bitemez: ok.',
    'Marketplace name cannot end with a dot: ok.'],
  [['rules.mpAdResmi'], () => Rules.checkMarketplaceName('claudeai-x'),
    'Bu ad resmi Anthropic marketplace\'lerine ayrılmış: claudeai-x',
    'This name is reserved for official Anthropic marketplaces: claudeai-x'],
  [['rules.mpAdDizin'], () => Rules.checkMarketplaceName('healthcare'),
    'Bu ad Claude dizinlerine ayrılmış: healthcare',
    'This name is reserved for Claude directories: healthcare'],
  [['rules.mpAdAyrilmis'], () => Rules.checkMarketplaceName('inline'),
    'Bu ad Claude Code tarafından ayrılmış: inline',
    'This name is reserved by Claude Code: inline'],
  [['rules.uzakAdGerekli'], () => Rules.checkRemoteName(''),
    'Uzak depo adı gerekli',
    'Remote name is required'],
  [['rules.uzakAdBicim'], () => Rules.checkRemoteName('Origin'),
    'Uzak depo adı küçük harf, rakam, ".", "_" ve "-" içermeli, harf ya da rakamla başlamalı (en çok 64 karakter)',
    'Remote name must use lowercase letters, digits, ".", "_" and "-", and must start with a letter or digit (at most 64 characters)'],
  [['rules.urlGerekli'], () => Rules.checkRemoteUrl(''),
    'URL gerekli',
    'URL is required'],
  [['rules.urlUzun'], () => Rules.checkRemoteUrl('https://github.com/o/' + 'r'.repeat(2100)),
    'URL en çok 2048 karakter olabilir',
    'URL can be at most 2048 characters'],
  [['rules.urlTire'], () => Rules.checkRemoteUrl('-oProxy=x'),
    'URL "-" ile başlayamaz',
    'URL cannot start with "-"'],
  [['rules.urlTur'], () => Rules.checkRemoteUrl('ext::sh -c x'),
    'Bu bağlantı türü güvenlik nedeniyle kapalı',
    'This connection type is disabled for security reasons'],
  [['rules.urlKarakter'], () => Rules.checkRemoteUrl('https://h/a b'),
    'URL boşluk veya kontrol karakteri içeremez',
    'URL cannot contain whitespace or control characters'],
  [['rules.urlHttp'], () => Rules.checkRemoteUrl('http://h/r.git'),
    'Şifresiz http kullanılmaz, https kullan',
    'Unencrypted http is not allowed, use https'],
  [['rules.urlGecersiz'], () => Rules.checkRemoteUrl('https://'),
    'URL geçersiz',
    'URL is not valid'],
  [['rules.urlParola'], () => Rules.checkRemoteUrl('https://u:p@h/r'),
    'Parola veya token URL\'ye yazılmaz (düz metin olarak .git/config\'e kaydedilir). Credential manager kullan.',
    'Passwords or tokens must not be written into the URL (it would be saved as plain text in .git/config). Use a credential manager.'],
  [['rules.urlYol'], () => Rules.checkRemoteUrl('https://github.com'),
    'URL depo yolunu içermeli (örnek: https://github.com/kullanıcı/depo)',
    'URL must include the repository path (example: https://github.com/user/repo)'],
  [['rules.urlMutlak'], () => Rules.checkRemoteUrl('goreli/yol'),
    'Mutlak bir yol ya da URL gir',
    'Enter an absolute path or a URL']
];

test('her ileti örneği: varsayılan bağlam ve tr Türkçe, en bağlamı İngilizce', () => {
  for (const [keys, call, wantTr, wantEn] of CASES) {
    const label = keys.join(', ');
    assert.equal(call(), wantTr, 'varsayılan ' + label);
    assert.equal(inTr(call), wantTr, 'tr ' + label);
    assert.equal(inEn(call), wantEn, 'en ' + label);
    assert.notEqual(wantEn, wantTr, 'en çevrilmiş ' + label);
  }
});

test('örnekler sözlükteki tüm rules.* anahtarlarını kapsar', () => {
  const used = [...new Set(CASES.flatMap(([keys]) => keys))].sort();
  assert.deepEqual(used, ruleKeys(TR));
  assert.equal(used.length, 62);
});

test('tr ve en: rules.* anahtar kümesi, yer tutucular ve çoğul kategorileri eşit; değerler boş değil', () => {
  assert.deepEqual(ruleKeys(EN), ruleKeys(TR));
  for (const key of ruleKeys(TR)) {
    const trValue = TR[key];
    const enValue = EN[key];
    assert.equal(typeof trValue, typeof enValue, 'aynı biçim (düz metin ya da çoğul) ' + key);
    const trVariants = variants(trValue);
    const enVariants = variants(enValue);
    const all = [...Object.values(trVariants), ...Object.values(enVariants)];
    assert.ok(all.every((text) => typeof text === 'string' && text.trim().length > 0), 'boş değer yok ' + key);
    const expected = placeholders(all[0]);
    for (const text of all) assert.deepEqual(placeholders(text), expected, 'yer tutucu kümesi ' + key + ': ' + text);
    if (typeof trValue === 'object') {
      assert.ok(expected.includes('count'), 'çoğul anahtar count ister ' + key);
      assert.ok('other' in trVariants && 'other' in enVariants, 'other kategorisi ' + key);
      assert.deepEqual(Object.keys(trVariants), ['other'], 'tr yalnızca other ' + key);
      assert.deepEqual(Object.keys(enVariants).sort(), ['one', 'other'], 'en one + other ' + key);
    }
  }
});

test('en değerlerinde Türkçe diyakritik ve en-GB yazım yok', () => {
  for (const key of ruleKeys(EN)) {
    for (const text of Object.values(variants(EN[key]))) {
      assert.ok(!DIACRITIC_RE.test(text), key + ': ' + text);
      assert.doesNotMatch(text, /initialis|cancell|colour|behaviour|catalogue|organis/i, key);
    }
  }
});

test('rules.js: tx anahtarları sözlükle birebir; çıplak çevrilmemiş ileti ve Türkçe diyakritikli dize yok', () => {
  const used = [...new Set([...RULES_SRC.matchAll(/\btx\('([^']+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(used, ruleKeys(TR), 'kaynakta kullanılan anahtarlar = sözlük anahtarları');
  assert.equal(RULES_SRC.match(/\btx\(/g).length, RULES_SRC.match(/\btx\('rules\./g).length, 'her tx çağrısı sabit anahtarla');
  const literals = stringLiterals(RULES_SRC);
  assert.deepEqual(literals.filter((text) => DIACRITIC_RE.test(text)), []);
  assert.ok(literals.length > 150, 'tarayıcı gerçekten dizeleri buluyor');
  assert.deepEqual(stringLiterals("a = /[\"']/; b = 'x/y'; // 'z'\nc = \"ş\"; d = x / 2; e = `t`"), ['x/y', 'ş', 't']);
});

test('API şekli: dışa açılan anahtarlar aynı; MSG ve LEVEL_LABEL anahtarları ve türleri korunur', () => {
  assert.deepEqual(Object.keys(Rules).sort(), EXPORTS);
  assert.deepEqual(Object.keys(Rules.MSG).sort(), [
    'adUretilemedi', 'anahtarTekrar', 'aygitAdi', 'dosyaBuyuk', 'durumHaric', 'onYuzKapanmamis', 'paketCokDegerli', 'paketUyusmuyor',
    'surumArtirilmamis', 'surumGuncelDegil', 'turGecersiz', 'turPrompt', 'turYok', 'yayinDisi'
  ]);
  const plain = ['onYuzKapanmamis', 'dosyaBuyuk', 'yayinDisi', 'turPrompt', 'paketCokDegerli'];
  for (const key of Object.keys(Rules.MSG)) {
    assert.equal(typeof Rules.MSG[key], plain.includes(key) ? 'string' : 'function', key);
    const descriptor = Object.getOwnPropertyDescriptor(Rules.MSG, key);
    assert.equal(descriptor.enumerable, true, key);
    assert.equal(typeof descriptor.get, plain.includes(key) ? 'function' : 'undefined', key);
  }
  assert.deepEqual(Object.keys(Rules.LEVEL_LABEL), ['buyuk', 'kucuk', 'yama']);
  for (const key of Object.keys(Rules.LEVEL_LABEL)) {
    assert.equal(typeof Rules.LEVEL_LABEL[key], 'string', key);
    assert.equal(typeof Object.getOwnPropertyDescriptor(Rules.LEVEL_LABEL, key).get, 'function', key);
  }
  assert.deepEqual(Rules.VERSION_LEVELS, ['buyuk', 'kucuk', 'yama']);
});

test('bayatlama yok: aynı modül örneği, art arda run; önceden alınan MSG ve LEVEL_LABEL güncel kalır', () => {
  const msg = Rules.MSG;
  const labels = Rules.LEVEL_LABEL;
  const read = () => [msg.dosyaBuyuk, msg.yayinDisi, msg.paketCokDegerli, labels.buyuk, labels.yama, Rules.checkVersion(''), Rules.checkRemoteUrl('')];
  const en1 = inEn(read);
  const tr1 = inTr(read);
  const en2 = inEn(read);
  const tr2 = read();
  assert.deepEqual(en1, [
    'The file is larger than 2 MB. It is not indexed or published.', 'No type selected (not published).', '"paket" must be a single value.',
    'Major', 'Patch', 'Version cannot be empty (example: 1.0.0)', 'URL is required'
  ]);
  assert.deepEqual(tr1, [
    "Dosya 2 MB'tan büyük. Dizinlenmiyor ve yayınlanmıyor.", 'Tür seçilmemiş (yayın dışı).', '"paket" tek bir değer olmalı.',
    'Büyük', 'Yama', 'Sürüm boş olamaz (örnek: 1.0.0)', 'URL gerekli'
  ]);
  assert.deepEqual(en2, en1);
  assert.deepEqual(tr2, tr1);
});

test('tembel alıcılar: yayılım ve serileştirme okuma anındaki dili kullanır', () => {
  assert.deepEqual(inEn(() => ({ ...Rules.LEVEL_LABEL })), { buyuk: 'Major', kucuk: 'Minor', yama: 'Patch' });
  assert.deepEqual(inTr(() => ({ ...Rules.LEVEL_LABEL })), { buyuk: 'Büyük', kucuk: 'Küçük', yama: 'Yama' });
  assert.equal(inEn(() => JSON.stringify(Rules.LEVEL_LABEL)), '{"buyuk":"Major","kucuk":"Minor","yama":"Patch"}');
  assert.equal(inEn(() => JSON.stringify(Rules.MSG)), JSON.stringify({
    onYuzKapanmamis: 'The frontmatter is not closed (there is no second "---" line). The fields cannot be read, so this prompt will not be published.',
    dosyaBuyuk: 'The file is larger than 2 MB. It is not indexed or published.',
    yayinDisi: 'No type selected (not published).',
    turPrompt: 'Prompt type: not published to Claude Code.',
    paketCokDegerli: '"paket" must be a single value.'
  }));
});

test('eşzamanlı isteklerde dil karışmaz (await sonrasında da)', async () => {
  const job = (lang, delay) => I18n.run(lang, async () => {
    const before = Rules.checkRemoteUrl('');
    await sleep(delay);
    return [before, Rules.checkRemoteUrl(''), Rules.LEVEL_LABEL.buyuk, Rules.MSG.yayinDisi];
  });
  const [a, b, c] = await Promise.all([job('en', 15), job('tr', 1), job('en', 5)]);
  const english = ['URL is required', 'URL is required', 'Major', 'No type selected (not published).'];
  assert.deepEqual(a, english);
  assert.deepEqual(c, english);
  assert.deepEqual(b, ['URL gerekli', 'URL gerekli', 'Büyük', 'Tür seçilmemiş (yayın dışı).']);
});

test('publishCheck: reason dil bağlamında üretilir, nesne şekli ve kodlar korunur', () => {
  const cases = [
    [{ fmBroken: true }, 'onYuzKapanmamis', 'warn',
      'The frontmatter is not closed (there is no second "---" line). The fields cannot be read, so this prompt will not be published.'],
    [{ meta: { tur: 'komutt' } }, 'turGecersiz', 'warn',
      'The "tur" value was not recognized: "komutt". Valid values: prompt, komut, ajan, skill. This prompt will not be published.'],
    [{ meta: { komut_adi: 'x', aciklama: 'y' }, hasFm: true }, 'turYok', 'warn',
      'Publish fields are filled in (komut_adi, aciklama) but "tur" is missing. This prompt will not be published.'],
    [{ meta: {} }, 'yayinDisi', 'info', 'No type selected (not published).'],
    [{ meta: { tur: 'prompt', aciklama: 'y' } }, 'yayinDisi', 'info', 'Prompt type: not published to Claude Code.']
  ];
  for (const [input, code, level, reasonEn] of cases) {
    const check = inEn(() => Rules.publishCheck(input));
    assert.equal(check.code, code);
    assert.equal(check.level, level);
    assert.equal(inEn(() => check.reason), reasonEn, code);
    assert.equal(inEn(() => Rules.publishCheck(input).reason), reasonEn, code);
    assert.equal(inTr(() => Rules.publishCheck(input).reason), Rules.publishCheck(input).reason, code);
    assert.notEqual(inTr(() => check.reason), reasonEn, 'okuma anındaki dil: ' + code);
    assert.deepEqual(Object.keys(check), code === 'turYok' ? ['code', 'level', 'reason', 'fields'] : ['code', 'level', 'reason']);
    assert.deepEqual(JSON.parse(inEn(() => JSON.stringify(check))).reason, reasonEn);
  }
  assert.deepEqual(inEn(() => Rules.publishCheck({ meta: { komut_adi: 'x', aciklama: 'y' } }).fields), ['komut_adi', 'aciklama']);
  assert.equal(inEn(() => Rules.publishCheck({ meta: { tur: 'Command' } })), null);
  assert.equal(inEn(() => Rules.publishCheck({ meta: { tur: 'komutt' }, fmBroken: true }).code), 'onYuzKapanmamis');
});

test('ileti parametreleri çevrilmeden aynen görünür: alan adları, kullanıcı girdisi, veri değerleri, $ kalıpları', () => {
  inEn(() => {
    assert.equal(Rules.MSG.turGecersiz('{value} $& Çok'),
      'The "tur" value was not recognized: "{value} $& Çok". Valid values: prompt, komut, ajan, skill. This prompt will not be published.');
    assert.equal(Rules.publishCheck({ meta: { tur: '$1 {field}' } }).reason,
      'The "tur" value was not recognized: "$1 {field}". Valid values: prompt, komut, ajan, skill. This prompt will not be published.');
    assert.equal(Rules.checkVersion('{field} $1'), 'Version must be in X.Y.Z format (example: 1.0.0): "{field} $1"');
    assert.equal(Rules.checkMarketplaceName('$&-{name}'),
      'Marketplace name must start with a letter or digit and can contain only letters, digits, ".", "_" and "-": $&-{name}');
    assert.equal(Rules.MSG.paketUyusmuyor('Kod İnceleme {x}', 'Çeşit $&'),
      'The file is in the folder of package "Kod İnceleme {x}" but its "paket" field is "Çeşit $&". The package is taken from the folder; fix the field or move the file.');
    assert.equal(Rules.MSG.durumHaric('arşiv', ['kararlı', '']), 'Status is "arşiv". Only these statuses are exported: kararlı, (empty).');
    assert.equal(Rules.MSG.surumGuncelDegil('1.0.2'),
      'The file has changed since the last version (v1.0.2) but "versiyon" is the same. Press +1 for a new version.');
    assert.equal(Rules.MSG.surumArtirilmamis('(boş)'),
      'The content has changed but "versiyon" was not bumped ((boş)). It will be counted as a patch.');
    assert.equal(Rules.MSG.adUretilemedi('$1 {fallback}'),
      'Could not generate a name ("$1 {fallback}"), so "adsiz" will be used. Enter a value containing a letter or digit in the "Name" field.');
    assert.equal(Rules.parseLibraryDir('x$&./y').error, 'a component cannot end with a dot or a space: "x$&."');
    assert.equal(Rules.checkPluginName('claude-$1'),
      '"claude-$1" is reserved for Anthropic (it cannot start with claude-, anthropic-, anthropics-, cc-plugin-; names such as claude, anthropic, claude-code cannot be used). Choose another name.');
    assert.equal(Rules.pluginNameWarn('my-claude-{x}'), '"my-claude-{x}" contains the word "claude"; Claude Code accepts this with a warning.');
    assert.equal(Rules.checkEntryName('NUL.md'), '"NUL.md" is a Windows device name and cannot be used as a file, folder or plugin name. Choose another name.');
    assert.equal(Rules.MSG.anahtarTekrar([{ key: 'ba$&lik', count: 2 }]), 'ba$&lik is written 2 times; the last one is used.');
  });
});

test('çoğul: en one/other, tr yalnızca other; düz anahtar adı iki kez sayılır', () => {
  const one = [{ key: 'baslik', count: 1 }];
  const two = [{ key: 'baslik', count: 2 }];
  assert.equal(inEn(() => Rules.MSG.anahtarTekrar(one)), 'baslik is written 1 time; the last one is used.');
  assert.equal(inEn(() => Rules.MSG.anahtarTekrar(two)), 'baslik is written 2 times; the last one is used.');
  assert.equal(inEn(() => Rules.MSG.anahtarTekrar(['baslik'])), 'baslik is written 2 times; the last one is used.');
  assert.equal(inTr(() => Rules.MSG.anahtarTekrar(one)), 'baslik 1 kez yazılmış; sonuncusu geçerli.');
  assert.equal(inTr(() => Rules.MSG.anahtarTekrar(two)), 'baslik 2 kez yazılmış; sonuncusu geçerli.');
  assert.equal(inEn(() => Rules.MSG.anahtarTekrar([{ key: 'a', count: 1 }, { key: 'b', count: 2 }])),
    'a (1 time), b (2 times) are written more than once; in each case the last one is used.');
  assert.equal(inTr(() => Rules.MSG.anahtarTekrar([{ key: 'a', count: 1 }, { key: 'b', count: 3 }])),
    'a (1 kez), b (3 kez) birden fazla kez yazılmış; hepsinde sonuncusu geçerli.');
});

test('dönüş biçimleri iki dilde aynı: null, { value, error }, { error } ve başarılı sonuçlar', () => {
  for (const run of [inTr, inEn]) {
    run(() => {
      assert.equal(Rules.checkVersion('1.0.0'), null);
      assert.equal(Rules.checkPluginName('kod'), null);
      assert.equal(Rules.pluginNameWarn('kod'), null);
      assert.equal(Rules.checkMarketplaceName('benim-promptlarim'), null);
      assert.equal(Rules.checkRemoteName('origin'), null);
      assert.equal(Rules.checkRemoteUrl('https://github.com/o/r.git'), null);
      assert.equal(Rules.checkEntryName('normal.md'), null);
      assert.deepEqual(Rules.parseLibraryDir('./prompts/'), { value: 'prompts', error: null });
      assert.deepEqual(Object.keys(Rules.parseLibraryDir('')), ['value', 'error']);
      assert.equal(Rules.parseLibraryDir('').value, null);
      assert.deepEqual(Rules.normalizeRepoUrl('o/r'), { url: 'https://github.com/o/r.git', provider: 'github', slugName: 'r' });
    });
  }
  assert.deepEqual(inEn(() => Rules.normalizeRepoUrl('')), { error: 'URL is required' });
  assert.deepEqual(inTr(() => Rules.normalizeRepoUrl('')), { error: 'URL gerekli' });
  assert.deepEqual(inEn(() => Rules.normalizeRepoUrl('ext::sh -c x')), { error: 'This connection type is disabled for security reasons' });
  assert.deepEqual(inEn(() => Rules.normalizeRepoUrl('https://github.com/o/' + 'x'.repeat(2100))), { error: 'URL can be at most 2048 characters' });
  assert.deepEqual(inTr(() => Rules.normalizeRepoUrl('https://github.com/o/' + 'x'.repeat(2100))), { error: 'URL en çok 2048 karakter olabilir' });
  assert.equal(inEn(() => Rules.checkRemoteUrl('https://u:p@h/r')), inEn(() => Rules.normalizeRepoUrl('https://u:p@h/r').error));
});

test('mevcut tüketici biçimleri: aygıt adı iletisi tüm doğrulayıcılarda aynı kaynaktan', () => {
  inEn(() => {
    const expected = Rules.MSG.aygitAdi('con');
    assert.equal(Rules.checkPluginName('CON'), expected);
    assert.equal(Rules.checkMarketplaceName('con'), Rules.MSG.aygitAdi('con'));
    assert.equal(Rules.checkEntryName('con'), expected);
  });
});

test('tarayıcı bağlamı: rules.js window.I18n ile yüklenir, setLanguage anında yansır', () => {
  const ctx = loadBrowser();
  const R = ctx.Rules;
  const B = ctx.I18n;
  assert.equal(typeof R.checkVersion, 'function');
  assert.equal(R.checkRemoteUrl(''), 'URL gerekli');
  assert.equal(B.setLanguage('en'), 'en');
  assert.equal(R.checkRemoteUrl(''), 'URL is required');
  assert.equal(R.checkVersion('1.0'), 'Version must be in X.Y.Z format (example: 1.0.0): "1.0"');
  assert.equal(R.MSG.dosyaBuyuk, 'The file is larger than 2 MB. It is not indexed or published.');
  assert.equal(R.MSG.durumHaric('taslak', ['kararlı', '']), 'Status is "taslak". Only these statuses are exported: kararlı, (empty).');
  assert.equal(R.LEVEL_LABEL.yama, 'Patch');
  assert.equal(R.publishCheck({ meta: {} }).reason, 'No type selected (not published).');
  assert.equal(R.checkPluginName('tools'), '"tools" is a reserved system name. Choose another name.');
  assert.equal(R.parseLibraryDir('a//b').error, 'cannot contain an empty or "." component');
  assert.equal(R.normalizeRepoUrl('').error, 'URL is required');
  assert.equal(B.setLanguage('tr'), 'tr');
  assert.equal(R.LEVEL_LABEL.yama, 'Yama');
  assert.equal(R.checkPluginName('tools'), '"tools" adı sistemde ayrılmış. Başka bir ad seç.');
  assert.equal(B.run('en', () => R.checkVersion('')), 'Version cannot be empty (example: 1.0.0)');
  assert.equal(R.checkVersion(''), 'Sürüm boş olamaz (örnek: 1.0.0)');
  assert.equal(B.missing.length, 0);
});

test('tarayıcı bağlamı: window.I18n dil değiştirince önceden alınmış MSG ve LEVEL_LABEL bayatlamaz', () => {
  const ctx = loadBrowser();
  const { Rules: R, I18n: B } = ctx;
  const labels = R.LEVEL_LABEL;
  assert.equal(labels.buyuk, 'Büyük');
  B.setLanguage('en');
  assert.equal(labels.buyuk, 'Major');
  B.setLanguage('tr');
  assert.equal(labels.buyuk, 'Büyük');
  const check = R.publishCheck({ meta: {} });
  B.setLanguage('en');
  assert.equal(check.reason, 'No type selected (not published).');
  B.setLanguage('tr');
  assert.equal(check.reason, 'Tür seçilmemiş (yayın dışı).');
});

test('kaynak ve sözlük dosyaları LF; bu dosyada CR yok', () => {
  for (const f of ['rules.js', 'lang/tr.js', 'lang/en.js']) {
    assert.ok(!fs.readFileSync(path.join(PUBLIC, f), 'utf8').includes('\r'), f);
  }
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
