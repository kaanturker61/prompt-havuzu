'use strict';
/* fm.js: frontmatter ayrıştırıcı/yazıcı (B-09 satır sonu yorumu, B-14 yinelenen anahtar, B-19 BOM gidiş-dönüş). */
const test = require('node:test');
const assert = require('node:assert/strict');
const FM = require('../public/fm.js');

const metaOf = (line) => FM.meta(FM.parse('---\n' + line + '\n---\ngovde\n'));

test('satır sonu yorumlu liste/tırnaklı değer tablosu (B-09)', () => {
  const t = [
    ['etiketler: [a, b]   # satır sonu yorumu', 'etiketler', ['a', 'b']],
    ['etiketler: [a, b] # y', 'etiketler', ['a', 'b']],
    ['etiketler: [a, "b # c"] # y', 'etiketler', ['a', 'b # c']],
    ["etiketler: ['a # x', b] # y", 'etiketler', ['a # x', 'b']],
    ['etiketler: [a, b]', 'etiketler', ['a', 'b']],
    ['etiketler: [a, b]#bitisik', 'etiketler', '[a, b]#bitisik'],
    ['etiketler: []   # bos', 'etiketler', []],
    ['baslik: "X" # not', 'baslik', 'X'],
    ["baslik: 'X' # not", 'baslik', 'X'],
    ["baslik: 'it''s' # not", 'baslik', "it's"],
    ['baslik: "a \\" # b" # not', 'baslik', 'a " # b'],
    ['baslik: "X"', 'baslik', 'X'],
    ['baslik: "X # içeride"', 'baslik', 'X # içeride'],
    ['baslik: "kapanmamis # x', 'baslik', '"kapanmamis # x'],
    ['x: a#b', 'x', 'a#b'],
    ['x: düz metin # yorum', 'x', 'düz metin'],
    ['x: düz #hash', 'x', 'düz'],
    ['x: #baslangic', 'x', '#baslangic'] // eskisi gibi: öncesinde boşluk yok
  ];
  for (const [line, key, want] of t) {
    assert.deepEqual(metaOf(line)[key], want, line);
  }
  // apostrof öğe başında değilse tırnak açmaz: yorum yine soyulur
  assert.equal(FM.stripComment("[it's, b] # y"), "[it's, b]");
  assert.equal(FM.stripComment('[a, "b # c"] # y'), '[a, "b # c"]');
  assert.equal(FM.stripComment('abc'), 'abc');
  assert.equal(FM.stripComment('"x" #y'), '"x"');
  assert.equal(FM.stripComment('[a]#y'), '[a]#y', 'öncesinde boşluk yoksa yorum değil');
});

test('etiket eklenince yalnızca o satır değişir; yorum ve diğer satırlar bayt bayt aynı (B-09)', () => {
  const raw = '---\nbaslik: "X" # not\n# tam satır yorumu\netiketler: [a, b]   # satır sonu yorumu\nozel: değer   # elle\n\ndurum: taslak\n---\ngövde\n';
  const p = FM.parse(raw);
  assert.deepEqual(FM.meta(p).etiketler, ['a', 'b']);
  assert.equal(FM.meta(p).baslik, 'X');
  FM.set(p, 'etiketler', ['a', 'b', 'c']);
  const out = FM.stringify(p);
  const a = raw.split('\n'); const b = out.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean);
  assert.deepEqual(changed, [['etiketler: [a, b]   # satır sonu yorumu', 'etiketler: [a, b, c]']]);
  // değişmeyen değer: hiçbir satır değişmez
  const p2 = FM.parse(raw);
  FM.set(p2, 'etiketler', ['a', 'b']);
  FM.set(p2, 'baslik', 'X');
  assert.equal(FM.stringify(p2), raw);
});

test('geriye uyum: yorumsuz değerler eskisi gibi okunur', () => {
  assert.deepEqual(metaOf('etiketler: [a, "b, c", d]').etiketler, ['a', 'b, c', 'd']);
  assert.equal(metaOf('baslik: "Merhaba \\"dünya\\""').baslik, 'Merhaba "dünya"');
  assert.equal(metaOf("baslik: 'tek'").baslik, 'tek');
  assert.equal(metaOf('baslik: Düz başlık').baslik, 'Düz başlık');
  assert.deepEqual(FM.meta(FM.parse('---\netiketler:\n  - a\n  - "b # c"\n---\nx')).etiketler, ['a', 'b # c']);
});

test('duplicateKeys (B-14)', () => {
  const p = FM.parse('---\nbaslik: A\ndurum: x\nbaslik: B\netiketler: [a]\nbaslik: C\netiketler: [b]\n---\nGövde CIFT\n');
  assert.deepEqual(FM.duplicateKeys(p), [{ key: 'baslik', count: 3 }, { key: 'etiketler', count: 2 }]);
  assert.equal(FM.meta(p).baslik, 'C', 'meta sonuncuyu okur');
  assert.deepEqual(FM.duplicateKeys(FM.parse('---\nbaslik: A\ndurum: x\n---\n')), []);
  assert.deepEqual(FM.duplicateKeys(FM.parse('gövde, frontmatter yok')), []);
  assert.deepEqual(FM.duplicateKeys(FM.parse('---\n# yorum\n# yorum\nbaslik: A\n---\n')), [], 'anahtarsız satırlar sayılmaz');
  assert.deepEqual(FM.duplicateKeys(FM.parse('---\nconstructor: 1\ntoString: 2\ntoString: 3\n---\n')), [{ key: 'toString', count: 2 }]);
});

test('set son girdiyi günceller, silme tüm kopyaları siler; gövde ve diğer satırlar korunur (B-14)', () => {
  const raw = '---\nbaslik: Ilk\ndurum: x\nbaslik: Son\n---\nGövde CIFT\n';
  const p = FM.parse(raw);
  FM.set(p, 'baslik', 'Yeni');
  assert.equal(FM.meta(p).baslik, 'Yeni', 'etkin (son) değer değişti');
  assert.equal(FM.stringify(p), '---\nbaslik: Ilk\ndurum: x\nbaslik: Yeni\n---\nGövde CIFT\n', 'yalnızca son satır yeniden yazıldı');
  assert.deepEqual(FM.duplicateKeys(p), [{ key: 'baslik', count: 2 }], 'kopya olduğu gibi kalır (K4: uyarı, engelleme yok)');
  // aynı değerle set: hiçbir şey değişmez
  const p2 = FM.parse(raw); FM.set(p2, 'baslik', 'Son');
  assert.equal(FM.stringify(p2), raw);
  // boş değer: tüm kopyalar silinir
  const p3 = FM.parse(raw); FM.set(p3, 'baslik', '');
  assert.equal(FM.stringify(p3), '---\ndurum: x\n---\nGövde CIFT\n');
  assert.equal(FM.meta(p3).baslik, undefined);
  const p4 = FM.parse('---\nbaslik: A\nbaslik: B\nbaslik: C\n---\ng'); FM.set(p4, 'baslik', []);
  assert.equal(FM.stringify(p4), 'g', 'tüm girdiler silinince frontmatter kalkar');
  // tek girdi ve yeni anahtar davranışı eskisi gibi
  const p5 = FM.parse('---\ndurum: x\n---\ng'); FM.set(p5, 'baslik', 'B'); FM.set(p5, 'durum', 'y');
  assert.equal(FM.stringify(p5), '---\nbaslik: B\ndurum: y\n---\ng');
  // blok liste girdisi çift ise son girdi (çok satırlı) tek satırlık biçime döner, ilki bozulmaz
  const p6 = FM.parse('---\netiketler: [a]\nx: 1\netiketler:\n  - b\n  - c\n---\ng'); FM.set(p6, 'etiketler', ['b', 'c', 'd']);
  assert.equal(FM.stringify(p6), '---\netiketler: [a]\nx: 1\netiketler: [b, c, d]\n---\ng');
});

test('rename biçimi korur, boolean tırnaksız yazılır, setBody "---" korumasını uygular', () => {
  const bom = String.fromCharCode(0xFEFF);
  const raw = bom + '---\r\naciklama: "Kod: inceleme"   # not\r\narguman_ipucu: [dosya]\r\naciklama: ikinci\r\ndescription: dolu\r\n---\r\ngövde\r\n';
  const p = FM.parse(raw);
  assert.equal(FM.rename(p, 'arguman_ipucu', 'argument-hint'), true);
  assert.equal(FM.rename(p, 'aciklama', 'description'), false, 'hedef doluyken dokunulmaz');
  assert.equal(FM.rename(p, 'yok', 'baska'), false);
  assert.equal(FM.stringify(p), raw.replace('arguman_ipucu', 'argument-hint'));
  FM.set(p, 'description', '');
  assert.equal(FM.rename(p, 'aciklama', 'description'), true, 'yinelenen kopyalar birlikte taşınır');
  assert.equal(FM.stringify(p), bom + '---\r\ndescription: "Kod: inceleme"   # not\r\nargument-hint: [dosya]\r\ndescription: ikinci\r\n---\r\ngövde\r\n');
  const q = FM.parse('---\nbaslik: A\n---\ng');
  FM.set(q, 'user-invocable', false); FM.set(q, 'background', true);
  assert.equal(FM.stringify(q), '---\nbaslik: A\nuser-invocable: false\nbackground: true\n---\ng');
  FM.set(q, 'background', true);
  assert.equal(FM.meta(q).background, 'true');
  assert.equal(FM.stringify(q), '---\nbaslik: A\nuser-invocable: false\nbackground: true\n---\ng');
  assert.equal(FM.stringify(FM.setBody(FM.parse(''), 'düz\n')), 'düz\n');
  assert.equal(FM.stringify(FM.setBody(FM.parse(''), '---\nçizgi\n')), '\n---\nçizgi\n');
  assert.equal(FM.parse(FM.stringify(FM.setBody(FM.parse(''), '---\nçizgi\n'))).hasFm, false);
  const r = FM.parse(''); FM.set(r, 'tur', 'komut'); FM.setBody(r, 'gövde\n');
  assert.equal(FM.stringify(r), '---\ntur: komut\n---\n\ngövde\n');
});

test('BOM gidiş-dönüş: korunur, BOM yoksa eklenmez (B-19)', () => {
  const raw = '\uFEFF---\nbaslik: A\netiketler: [x]\n---\nGövde\n';
  const p = FM.parse(raw);
  assert.equal(p.bom, '\uFEFF');
  assert.equal(FM.meta(p).baslik, 'A', 'BOM anahtar adını bozmaz');
  assert.equal(FM.stringify(p), raw, 'değişiklik yokken bayt bayt aynı');
  FM.set(p, 'etiketler', ['x', 'y']);
  const out = FM.stringify(p);
  assert.equal(out.charCodeAt(0), 0xFEFF);
  assert.equal(out, '\uFEFF---\nbaslik: A\netiketler: [x, y]\n---\nGövde\n');
  // BOM'suz dosyaya BOM eklenmez
  const q = FM.parse('---\nbaslik: A\n---\ng'); FM.set(q, 'durum', 'x');
  assert.equal(FM.stringify(q).charCodeAt(0), 0x2D);
  // CRLF + BOM birlikte
  const c = FM.parse('\uFEFF---\r\nbaslik: A\r\n---\r\ng\r\n'); FM.set(c, 'durum', 'x');
  assert.equal(FM.stringify(c), '\uFEFF---\r\nbaslik: A\r\ndurum: x\r\n---\r\ng\r\n');
  // frontmatter'siz BOM'lu dosya
  assert.equal(FM.stringify(FM.parse('\uFEFFdüz metin')), '\uFEFFdüz metin');
});
