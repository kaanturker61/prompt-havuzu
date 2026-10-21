'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');
const { promisify } = require('util');
const I18n = require('../public/i18n.js');
const { GitService } = require('../lib/git-service');
const { gitAvailable, tmpDir, rmrf } = require('./helpers');

const PUBLIC = path.join(__dirname, '..', 'public');

const DICT = {
  tr: {
    greet: 'Merhaba {ad}',
    'only.tr': 'Yalnızca Türkçe',
    commits: { other: '{count} commit' },
    files: { other: '{count} dosya' },
    html: '<b>{ad}</b> girdi',
    pair: '{x} ve {ad}',
    who: 'Ben {ad}'
  },
  en: {
    greet: 'Hello {ad}',
    commits: { one: '{count} commit', other: '{count} commits' },
    files: { other: '{count} files' },
    html: '<b>{ad}</b> signed in',
    pair: '{x} and {ad}',
    who: 'I am {ad}'
  }
};

/** Summary: Sahte sözlükle bağımsız çeviri örneği kurar. */
function fresh() {
  return I18n.create(DICT);
}

/** Summary: Verilen süre sonra çözülen söz. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('LANGUAGES ve yerel ayarlar', () => {
  assert.deepEqual([...I18n.LANGUAGES], ['tr', 'en']);
  assert.equal(I18n.DEFAULT_LANGUAGE, 'tr');
  assert.equal(I18n.locale('tr'), 'tr-TR');
  assert.equal(I18n.locale('en'), 'en-US');
  assert.equal(I18n.locale('fr'), 'tr-TR', 'geçersiz dil geçerli dile düşer');
});

test('yer tutucu: {ad} doldurulur, tx dile göre seçer', () => {
  const i = fresh();
  assert.equal(i.tx('greet', { ad: 'Ali' }), 'Merhaba Ali');
  assert.equal(i.tx('greet', { ad: 'Ali' }, { lang: 'en' }), 'Hello Ali');
  assert.equal(i.run('en', () => i.tx('greet', { ad: 'Ali' })), 'Hello Ali');
  assert.equal(i.tx('greet', { ad: 0 }), 'Merhaba 0');
  assert.equal(i.tx('greet'), 'Merhaba {ad}', 'params yoksa yer tutucu kalır');
});

test('yer tutucu: parametre değerindeki $ kalıpları tetiklenmez, değer yeniden taranmaz', () => {
  const i = fresh();
  const nasty = "$& $1 $$ $` $' {x} $<n>";
  assert.equal(i.tx('greet', { ad: nasty }), 'Merhaba ' + nasty);
  assert.equal(i.tx('pair', { x: '{ad}', ad: 'B' }), '{ad} ve B', 'tek geçiş: eklenen metin yeniden taranmaz');
  assert.equal(i.th('greet', { ad: '$&' }), 'Merhaba $&amp;', 'th: önce kaçışlanır, $& kalıbı yine tetiklenmez');
  assert.equal(i.th('greet', { ad: '$1 $$' }), 'Merhaba $1 $$');
});

test('yer tutucu: bilinmeyen {x}, null/undefined ve prototip anahtarları olduğu gibi kalır', () => {
  const i = fresh();
  assert.equal(i.tx('pair', { ad: 'B' }), '{x} ve B');
  assert.equal(i.tx('pair', { x: undefined, ad: null }), '{x} ve {ad}');
  assert.equal(i.tx('pair', Object.create({ x: 'kalıtılmış', ad: 'B' })), '{x} ve {ad}');
  const dict = I18n.create({ tr: { p: '{constructor} {toString} {__proto__}' } });
  assert.equal(dict.tx('p', {}), '{constructor} {toString} {__proto__}');
});

test('çoğul: en one/other, tr yalnızca other, kategori yoksa other', () => {
  const i = fresh();
  assert.equal(i.tx('commits', { count: 1 }, { lang: 'en' }), '1 commit');
  assert.equal(i.tx('commits', { count: 0 }, { lang: 'en' }), '0 commits');
  assert.equal(i.tx('commits', { count: 2 }, { lang: 'en' }), '2 commits');
  assert.equal(i.tx('commits', { count: 1 }), '1 commit', 'tr: one kategorisi yok, other kullanılır');
  assert.equal(i.tx('commits', { count: 3 }), '3 commit');
  assert.equal(i.tx('files', { count: 1 }, { lang: 'en' }), '1 files', 'en: one kategorisi yoksa other');
  assert.deepEqual(i.missing, []);
});

test('çoğul: params.count yoksa ya da sayı değilse TypeError', () => {
  const i = fresh();
  assert.throws(() => i.tx('commits'), TypeError);
  assert.throws(() => i.tx('commits', {}), /params\.count/);
  assert.throws(() => i.tx('commits', { count: '2' }), TypeError);
  assert.throws(() => i.tx('commits', { count: NaN }, { lang: 'en' }), TypeError);
  assert.throws(() => i.th('commits', { count: undefined }), TypeError);
});

test('eksik anahtar yedeği: istenen dil -> tr -> anahtar metni, missing toplar', () => {
  const i = fresh();
  assert.deepEqual(i.missing, []);
  assert.equal(i.tx('only.tr', {}, { lang: 'en' }), 'Yalnızca Türkçe');
  assert.deepEqual(i.missing, ['en:only.tr']);
  assert.equal(i.tx('only.tr', {}, { lang: 'en' }), 'Yalnızca Türkçe');
  assert.deepEqual(i.missing, ['en:only.tr'], 'yinelenmez');
  assert.equal(i.tx('yok.anahtar', { a: 1 }, { lang: 'en' }), 'yok.anahtar');
  assert.deepEqual(i.missing, ['en:only.tr', 'en:yok.anahtar', 'tr:yok.anahtar']);
  assert.equal(i.tx('yok.anahtar'), 'yok.anahtar');
  assert.equal(i.th('<yok>'), '&lt;yok&gt;', 'th anahtar metnini kaçışlar');
  assert.equal(i.tx('constructor'), 'constructor', 'prototip anahtarı sözlük girdisi sayılmaz');
  assert.equal(i.tx('__proto__', {}, { lang: 'en' }), '__proto__');
  assert.equal(i.tx('only.tr'), 'Yalnızca Türkçe');
  assert.ok(!i.missing.includes('tr:only.tr'));
});

test('eksik anahtar: sözlüğü olmayan örnek anahtarı döner', () => {
  const i = I18n.create();
  assert.equal(i.tx('a.b'), 'a.b');
  assert.equal(i.tx('a.b', {}, { lang: 'en' }), 'a.b');
  const onlyEn = I18n.create({ en: { k: 'Only en' } });
  assert.equal(onlyEn.tx('k'), 'k', 'yedek tr olduğu için en girdisi tr bağlamında görünmez');
  assert.equal(onlyEn.tx('k', {}, { lang: 'en' }), 'Only en');
});

test('th: parametreler kaçışlanır, raw kaçışlanmaz, sözlük metni güvenilir', () => {
  const i = fresh();
  assert.equal(i.th('html', { ad: '<img src=x onerror="a()">' }), '<b>&lt;img src=x onerror=&quot;a()&quot;&gt;</b> girdi');
  assert.equal(i.th('html', { ad: "A&B 'c'" }), "<b>A&amp;B &#39;c&#39;</b> girdi");
  assert.equal(i.th('html', { ad: i.raw('<i>x</i>') }), '<b><i>x</i></b> girdi');
  assert.equal(i.th('html', { ad: 5 }, { lang: 'en' }), '<b>5</b> signed in');
  assert.equal(i.tx('html', { ad: '<i>' }), '<b><i></b> girdi', 'tx kaçışlamaz');
  assert.equal(i.tx('html', { ad: i.raw('<i>x</i>') }), '<b><i>x</i></b> girdi');
  assert.equal(i.raw(7).toString(), '7');
});

test('resolve(): ayar ve tarayıcı dili tablosu', () => {
  const cases = [
    ['tr', 'en-US', 'tr'], ['en', 'tr-TR', 'en'], ['tr', undefined, 'tr'], ['en', undefined, 'en'],
    ['auto', 'tr', 'tr'], ['auto', 'tr-TR', 'tr'], ['auto', 'TR-tr', 'tr'], ['auto', 'tr_TR', 'tr'],
    ['auto', 'en-US', 'en'], ['auto', 'en', 'en'], ['auto', 'de-DE', 'en'], ['auto', 'fr', 'en'],
    ['auto', 'trk', 'en'], ['auto', '', 'en'], ['auto', undefined, 'en'], ['auto', null, 'en'],
    ['fr', 'tr-TR', 'tr'], ['fr', 'en-US', 'en'], ['', 'tr', 'tr'], [undefined, 'tr-TR', 'tr'],
    [null, 'de', 'en'], [undefined, undefined, 'en'], ['TR', 'en-US', 'en'], [42, 'tr', 'tr']
  ];
  for (const [setting, nav, want] of cases) {
    assert.equal(I18n.resolve(setting, nav), want, `resolve(${JSON.stringify(setting)}, ${JSON.stringify(nav)})`);
  }
});

test('run/current: bağlam yokken tr, geçersiz dil tr, dönüş değeri aktarılır', async () => {
  assert.equal(I18n.current(), 'tr');
  assert.equal(I18n.run('en', () => I18n.current()), 'en');
  assert.equal(I18n.run('fr', () => I18n.current()), 'tr');
  assert.equal(I18n.run(undefined, () => I18n.current()), 'tr');
  assert.equal(await I18n.run('en', async () => 42), 42);
  assert.equal(I18n.current(), 'tr', 'run bittikten sonra bağlam sızmaz');
});

test('run: iç içe dil, await sonrası yayılım ve opts.lang geçersiz kılma', async () => {
  const i = fresh();
  const seen = await i.run('en', async () => {
    const out = [i.current()];
    await sleep(5);
    out.push(i.current(), i.tx('greet', { ad: 'A' }));
    await i.run('tr', async () => {
      await sleep(5);
      out.push(i.current(), i.tx('greet', { ad: 'A' }));
      out.push(i.tx('greet', { ad: 'A' }, { lang: 'en' }));
    });
    out.push(i.current(), i.tx('greet', { ad: 'A' }));
    await Promise.resolve();
    out.push(i.tx('greet', { ad: 'A' }, { lang: 'tr' }), i.tx('greet', { ad: 'A' }, { lang: 'fr' }));
    return out;
  });
  assert.deepEqual(seen, ['en', 'en', 'Hello A', 'tr', 'Merhaba A', 'Hello A', 'en', 'Hello A', 'Merhaba A', 'Hello A']);
  assert.equal(i.current(), 'tr');
});

test('run: eşzamanlı iki run birbirini ezmez', async () => {
  const i = fresh();
  const job = (lang, delays) => i.run(lang, async () => {
    const out = [];
    for (const d of delays) { await sleep(d); out.push(i.current() + ':' + i.tx('who', { ad: lang })); }
    return out;
  });
  const [a, b, c] = await Promise.all([job('en', [1, 15, 1]), job('tr', [10, 1, 10]), job('en', [5, 5, 5])]);
  assert.deepEqual(a, ['en:I am en', 'en:I am en', 'en:I am en']);
  assert.deepEqual(b, ['tr:Ben tr', 'tr:Ben tr', 'tr:Ben tr']);
  assert.deepEqual(c, ['en:I am en', 'en:I am en', 'en:I am en']);
});

test('run: çok sayıda eşzamanlı bağlam karışmaz', async () => {
  const jobs = [];
  for (let n = 0; n < 40; n++) {
    const lang = n % 2 ? 'en' : 'tr';
    jobs.push(I18n.run(lang, async () => {
      await sleep((n * 7) % 11);
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      return I18n.current() === lang;
    }));
  }
  assert.deepEqual(new Set(await Promise.all(jobs)), new Set([true]));
});

test('ALS: execFile geri çağrısında ve promisify ile dil korunur', async () => {
  const inCallback = await I18n.run('en', () => new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', ''], (err) => (err ? reject(err) : resolve(I18n.current())));
  }));
  assert.equal(inCallback, 'en');

  const afterPromisified = await I18n.run('en', async () => {
    await promisify(execFile)(process.execPath, ['-v']);
    return I18n.current();
  });
  assert.equal(afterPromisified, 'en');

  const afterFailure = await I18n.run('en', async () => {
    try { await promisify(execFile)(process.execPath, ['-e', 'process.exit(3)']); } catch (e) {}
    return I18n.current();
  });
  assert.equal(afterFailure, 'en');

  const pending = I18n.run('en', async () => { await sleep(30); return I18n.current(); });
  const outside = await new Promise((resolve) => {
    execFile(process.execPath, ['-e', ''], () => resolve(I18n.current()));
  });
  assert.equal(outside, 'tr', 'run dışında başlatılan çağrı, başka bir run sürerken dil bağlamı almaz');
  assert.equal(await pending, 'en');
});

test('ALS: git çağrısına gidip dönen akışta dil korunur (GitService)', { skip: !gitAvailable && 'git yok' }, async () => {
  const tmp = tmpDir();
  try {
    const git = new GitService();
    const [en, tr, failed] = await Promise.all([
      I18n.run('en', async () => { await git.version(); return I18n.current(); }),
      I18n.run('tr', async () => { await git.version(); return I18n.current(); }),
      I18n.run('en', async () => {
        try { await git.run(tmp, ['bu-komut-yok']); } catch (e) { return I18n.current(); }
        return 'hata-yok';
      })
    ]);
    assert.equal(en, 'en');
    assert.equal(tr, 'tr');
    assert.equal(failed, 'en');
  } finally { rmrf(tmp); }
});

test('setLanguage sunucuda (ALS varken) kullanılamaz', () => {
  assert.throws(() => I18n.setLanguage('en'), /yalnızca tarayıcıda/);
  assert.equal(I18n.current(), 'tr');
});

/** Summary: index.html betik sırasıyla sözlükleri ve çekirdeği boş bir tarayıcı bağlamına yükler. */
function loadBrowser() {
  const ctx = vm.createContext({});
  for (const f of ['lang/tr.js', 'lang/en.js', 'i18n.js']) {
    vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

test('tarayıcı kipi: window.I18n, global sözlükler, setLanguage ve run', () => {
  const ctx = loadBrowser();
  const B = ctx.I18n;
  assert.equal(typeof B.tx, 'function');
  assert.equal(ctx.PP_LANG_TR['err.api.notFound'], 'Bulunamadı');
  assert.equal(ctx.PP_LANG_EN['err.api.notFound'], 'Not found');
  assert.equal(B.current(), 'tr');
  assert.equal(B.tx('err.api.notFound'), 'Bulunamadı');
  assert.equal(B.setLanguage('en'), 'en');
  assert.equal(B.current(), 'en');
  assert.equal(B.tx('err.api.notFound'), 'Not found');
  assert.equal(B.tx('err.api.notFound', {}, { lang: 'tr' }), 'Bulunamadı');
  assert.equal(B.run('tr', () => B.tx('err.api.notFound')), 'Bulunamadı');
  assert.equal(B.current(), 'en', 'run bitince önceki dil döner');
  assert.throws(() => B.run('tr', () => { throw new Error('x'); }), /x/);
  assert.equal(B.current(), 'en', 'hata olsa da önceki dil döner');
  assert.equal(B.setLanguage('fr'), 'tr', 'geçersiz dil tr olur');
  assert.equal(B.locale(), 'tr-TR');
  assert.equal(B.resolve('auto', 'en-GB'), 'en');
  assert.equal(B.missing.length, 0);
  const custom = B.create({ tr: { a: 'A {n}' } });
  assert.equal(custom.tx('a', { n: 1 }), 'A 1');
});

test('gerçek sözlükler: kanarya anahtarı iki dilde, anahtar kümeleri eşit, eksik anahtar yok', () => {
  const tr = require('../public/lang/tr.js');
  const en = require('../public/lang/en.js');
  assert.equal(tr['err.api.notFound'], 'Bulunamadı');
  assert.equal(en['err.api.notFound'], 'Not found');
  assert.deepEqual(Object.keys(tr).sort(), Object.keys(en).sort());
  assert.equal(I18n.run('tr', () => I18n.tx('err.api.notFound')), 'Bulunamadı');
  assert.equal(I18n.run('en', () => I18n.tx('err.api.notFound')), 'Not found');
  assert.equal(I18n.tx('err.api.notFound', {}, { lang: 'en' }), 'Not found');
  assert.deepEqual(I18n.missing, []);
});

test('index.html: betik sırası lang/tr.js, lang/en.js, i18n.js, fm.js, rules.js', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ['/lang/tr.js', '/lang/en.js', '/i18n.js', '/fm.js', '/rules.js']);
});

/** Summary: Yerel saatle sabit bir an (gün/saat dilimi kaymasından bağımsız) ISO dizesi. */
const WHEN = new Date(2026, 2, 5, 14, 5).toISOString();

test('date/time: tr-TR ve en-US biçimi geçerli dili izler; tarih+saat ve yalnızca saat', () => {
  const fmt = (locale, opts) => new Intl.DateTimeFormat(locale, opts).format(new Date(WHEN));
  const both = { dateStyle: 'medium', timeStyle: 'short' };
  assert.equal(I18n.date(WHEN), fmt('tr-TR', both));
  assert.equal(I18n.time(WHEN), fmt('tr-TR', { timeStyle: 'short' }));
  assert.equal(I18n.run('en', () => I18n.date(WHEN)), fmt('en-US', both));
  assert.equal(I18n.run('en', () => I18n.time(WHEN)), fmt('en-US', { timeStyle: 'short' }));
  assert.match(I18n.date(WHEN), /^5 Mar 2026,? 14:05$/);
  assert.equal(I18n.time(WHEN), '14:05');
  assert.match(I18n.run('en', () => I18n.date(WHEN)), /^Mar 5, 2026, 2:05\sPM$/);
  assert.match(I18n.run('en', () => I18n.time(WHEN)), /^2:05\sPM$/);
  assert.equal(I18n.date(new Date(WHEN)), I18n.date(WHEN), 'Date nesnesi de kabul edilir');
});

test('date/time: geçersiz girdi bozulmadan döner, null/undefined boş; dil değişince önbellek karışmaz', () => {
  assert.equal(I18n.date('bozuk tarih'), 'bozuk tarih');
  assert.equal(I18n.time('bozuk tarih'), 'bozuk tarih');
  assert.equal(I18n.date(undefined), '');
  assert.equal(I18n.time(null), '');
  const i = fresh();
  const tr1 = i.date(WHEN);
  const en1 = i.run('en', () => i.date(WHEN));
  assert.notEqual(tr1, en1);
  assert.equal(i.date(WHEN), tr1);
  assert.equal(i.run('en', () => i.date(WHEN)), en1);
});

test('date/time: tarayıcı kipinde setLanguage ile dil değişir', () => {
  const B = loadBrowser().I18n;
  const tr = B.date(WHEN);
  B.setLanguage('en');
  const en = B.date(WHEN);
  assert.match(tr, /^5 Mar 2026,? 14:05$/);
  assert.match(en, /^Mar 5, 2026, 2:05\sPM$/);
  assert.match(B.time(WHEN), /^2:05\sPM$/);
});

/** Summary: querySelectorAll('[öznitelik]') destekleyen sahte öğe ağacı. */
function fakeDom(specs) {
  const nodes = specs.map((attrs) => {
    const map = { ...attrs };
    return {
      map,
      textContent: 'eski',
      getAttribute: (k) => (k in map ? map[k] : null),
      setAttribute: (k, v) => { map[k] = String(v); }
    };
  });
  return {
    nodes,
    querySelectorAll(selector) {
      const m = /^\[([\w-]+)\]$/.exec(selector);
      assert.ok(m, 'beklenmeyen seçici: ' + selector);
      return nodes.filter((n) => m[1] in n.map);
    }
  };
}

test('applyDom: data-i18n -> textContent; title, placeholder, aria-label öznitelikleri; dile göre', () => {
  const i = fresh();
  const dom = fakeDom([
    { 'data-i18n': 'greet' },
    { 'data-i18n-title': 'who', title: 'eski başlık' },
    { 'data-i18n-placeholder': 'pair' },
    { 'data-i18n-aria-label': 'only.tr' },
    { 'data-i18n': 'greet', 'data-i18n-title': 'who' },
    { id: 'baglantisiz' }
  ]);
  const [a, b, c, d, e, f] = dom.nodes;
  assert.equal(i.applyDom(dom), 6);
  assert.equal(a.textContent, 'Merhaba {ad}', 'params verilmez: yer tutucu kalır');
  assert.equal(b.map.title, 'Ben {ad}');
  assert.equal(b.textContent, 'eski', 'yalnızca ilgili öznitelik doldurulur');
  assert.equal(c.map.placeholder, '{x} ve {ad}');
  assert.equal(d.map['aria-label'], 'Yalnızca Türkçe');
  assert.equal(e.textContent, 'Merhaba {ad}');
  assert.equal(e.map.title, 'Ben {ad}');
  assert.equal(f.textContent, 'eski');
  assert.equal(f.map.title, undefined);

  assert.equal(i.run('en', () => i.applyDom(dom)), 6);
  assert.equal(a.textContent, 'Hello {ad}');
  assert.equal(b.map.title, 'I am {ad}');
  assert.equal(d.map['aria-label'], 'Yalnızca Türkçe', 'eksik en anahtarı tr yedeğine düşer');
  assert.equal(c.map.placeholder, '{x} and {ad}');
});

test('applyDom: eksik anahtar metni anahtar olur; kök yoksa ve Node\'da document yoksa 0', () => {
  const i = fresh();
  const dom = fakeDom([{ 'data-i18n': 'yok.anahtar' }]);
  assert.equal(i.applyDom(dom), 1);
  assert.equal(dom.nodes[0].textContent, 'yok.anahtar');
  assert.equal(i.applyDom(), 0);
  assert.equal(i.applyDom(fakeDom([])), 0);
});

test('applyDom: tarayıcı kipinde varsayılan kök global document; gerçek sözlükle', () => {
  const ctx = loadBrowser();
  const dom = fakeDom([{ 'data-i18n': 'ui.static.settings' }, { 'data-i18n-aria-label': 'ui.static.library' }]);
  ctx.document = dom;
  vm.runInContext('I18n.setLanguage("en")', ctx);
  assert.equal(vm.runInContext('I18n.applyDom()', ctx), 2);
  assert.equal(dom.nodes[0].textContent, 'Settings');
  assert.equal(dom.nodes[1].map['aria-label'], 'Library');
  vm.runInContext('I18n.setLanguage("tr")', ctx);
  vm.runInContext('I18n.applyDom(document)', ctx);
  assert.equal(dom.nodes[0].textContent, 'Ayarlar');
  assert.equal(dom.nodes[1].map['aria-label'], 'Kütüphane');
});

test('yeni kaynak dosyalarda CR yok (LF)', () => {
  for (const f of ['i18n.js', 'lang/tr.js', 'lang/en.js']) {
    assert.ok(!fs.readFileSync(path.join(PUBLIC, f), 'utf8').includes('\r'), f);
  }
  assert.ok(!fs.readFileSync(__filename, 'utf8').includes('\r'));
});
