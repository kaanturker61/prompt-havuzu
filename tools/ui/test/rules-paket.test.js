'use strict';
/* Aşama 4 kuralları: paket çözümleme, sürüm seviyesi, ad ve URL doğrulama. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules.js');

test('MSG: durumHaric ve surumArtirilmamis', () => {
  assert.equal(Rules.MSG.durumHaric('taslak', ['kararlı', '']), 'Durumu "taslak". Yalnızca şu durumlar dışa aktarılır: kararlı, (boş).');
  assert.match(Rules.MSG.durumHaric('', ['kararlı']), /^Durumu boş\. /);
  assert.equal(Rules.MSG.surumArtirilmamis('1.0.2'), 'İçerik değişmiş ama "versiyon" artırılmamış (1.0.2). Yama sayılacak.');
});

test('levelBetween ve maxLevel', () => {
  assert.equal(Rules.levelBetween('1.0.0', '2.0.0'), 'buyuk');
  assert.equal(Rules.levelBetween('1.0.2', '1.1.0'), 'kucuk');
  assert.equal(Rules.levelBetween('1.0.0', '1.0.1'), 'yama');
  assert.equal(Rules.levelBetween('1.0.0', '1.0.0'), null);
  assert.equal(Rules.levelBetween('2.0.0', '1.0.0'), null);
  assert.equal(Rules.levelBetween('1', '2'), 'buyuk');
  assert.equal(Rules.levelBetween('abc', '1.0.0'), null);
  assert.equal(Rules.maxLevel(['yama', 'kucuk']), 'kucuk');
  assert.equal(Rules.maxLevel(['yama', 'buyuk', 'kucuk']), 'buyuk');
  assert.equal(Rules.maxLevel([]), null);
});

test('packageTag ve parsePackageTag', () => {
  assert.equal(Rules.packageTag('ornek', '1.2.0'), 'paket/ornek/v1.2.0');
  assert.deepEqual(Rules.parsePackageTag('paket/ornek/v1.2.0'), { ad: 'ornek', version: '1.2.0' });
  assert.equal(Rules.parsePackageTag('prompt/ornek/x/v1.2.0'), null);
  assert.equal(Rules.parsePackageTag('paket/a/b/v1.0.0'), null);
  assert.equal(Rules.parsePackageTag('paket/ornek/v1.2'), null);
});

test('resolvePackage tablosu', () => {
  const r = (rel, extra) => Rules.resolvePackage({ rel, libraryDir: 'prompts', defaultPaket: 'Varsayilan', haricKlasorler: ['gelen-kutusu'], ...extra });
  assert.deepEqual(r('prompts/ornek/x.md'), { paket: 'ornek', kaynak: 'klasor' });
  assert.deepEqual(r('prompts/ornek/alt/x.md', { metaPaket: 'ornek' }), { paket: 'ornek', kaynak: 'klasor' });
  assert.equal(r('prompts/Örnek Paket/x.md').paket, 'ornek-paket');
  let x = r('prompts/ornek/x.md', { metaPaket: 'baska' });
  assert.equal(x.paket, 'ornek'); assert.equal(x.code, 'paketUyusmuyor'); assert.equal(x.level, 'warn'); assert.equal(x.alan, 'baska');
  x = r('prompts/ornek/x.md', { metaPaket: ['a', 'b'] });
  assert.equal(x.code, 'paketCokDegerli');
  assert.deepEqual(r('prompts/x.md', { metaPaket: 'Alan Paketi' }), { paket: 'alan-paketi', kaynak: 'alan' });
  x = r('prompts/x.md');
  assert.equal(x.paket, 'varsayilan'); assert.equal(x.kaynak, 'varsayilan'); assert.equal(x.code, 'paketKlasoruYok'); assert.equal(x.level, 'info');
  x = r('prompts/gelen-kutusu/x.md');
  assert.equal(x.paket, null); assert.equal(x.code, 'paketDisiKlasor');
  x = r('prompts/arsiv/x.md', { haricKlasorler: ['arsiv'] });
  assert.equal(x.paket, null); assert.equal(x.code, 'paketDisiKlasor');
  assert.equal(r('plugins/a/x.md').paket, null);
});

test('durumAllowed', () => {
  const l = ['kararlı', ''];
  assert.equal(Rules.durumAllowed('', l), true);
  assert.equal(Rules.durumAllowed(undefined, l), true);
  assert.equal(Rules.durumAllowed('kararli', l), true);
  assert.equal(Rules.durumAllowed('Kararlı', l), true);
  assert.equal(Rules.durumAllowed('taslak', l), false);
  assert.equal(Rules.durumAllowed('', ['kararlı']), false);
});

test('checkMarketplaceName', () => {
  assert.equal(Rules.checkMarketplaceName('benim-promptlarim'), null);
  assert.equal(Rules.checkMarketplaceName('a.b_c-1'), null);
  assert.match(Rules.checkMarketplaceName(''), /gerekli/);
  assert.match(Rules.checkMarketplaceName('-x'), /harf ya da rakamla/);
  assert.match(Rules.checkMarketplaceName('a..b'), /harf ya da rakamla/);
  assert.match(Rules.checkMarketplaceName('claude-plugins-official'), /ayrılmış/);
  assert.match(Rules.checkMarketplaceName('claudeai-x'), /ayrılmış/);
  assert.match(Rules.checkMarketplaceName('Anthropic_Marketplace'), /harf ya da rakamla|ayrılmış/);
  assert.match(Rules.checkMarketplaceName('anthropic-marketplace'), /ayrılmış/);
  assert.match(Rules.checkMarketplaceName('GitHub'), /ayrılmış/);
  assert.match(Rules.checkMarketplaceName('inline'), /ayrılmış/);
  assert.match(Rules.checkMarketplaceName('healthcare'), /ayrılmış/);
});

test('checkRemoteName ve checkRemoteUrl', () => {
  assert.equal(Rules.checkRemoteName('origin'), null);
  assert.match(Rules.checkRemoteName('Origin'), /küçük harf/);
  assert.match(Rules.checkRemoteName(''), /gerekli/);
  assert.match(Rules.checkRemoteName('a b'), /küçük harf/);
  assert.equal(Rules.checkRemoteUrl('-oProxy=x'), 'URL "-" ile başlayamaz');
  assert.equal(Rules.checkRemoteUrl('ext::sh -c x'), 'Bu bağlantı türü güvenlik nedeniyle kapalı');
  assert.equal(Rules.checkRemoteUrl('fd::3'), 'Bu bağlantı türü güvenlik nedeniyle kapalı');
  assert.equal(Rules.checkRemoteUrl('http://h/r.git'), 'Şifresiz http kullanılmaz, https kullan');
  assert.match(Rules.checkRemoteUrl('https://u:p@h/r'), /^Parola veya token/);
  assert.match(Rules.checkRemoteUrl('https://ghp_abc@github.com/o/r'), /^Parola veya token/);
  assert.equal(Rules.checkRemoteUrl('goreli/yol'), 'Mutlak bir yol ya da URL gir');
  assert.equal(Rules.checkRemoteUrl('https://h/a b'), 'URL boşluk veya kontrol karakteri içeremez');
  assert.equal(Rules.checkRemoteUrl(''), 'URL gerekli');
  for (const ok of ['https://github.com/o/r.git', 'ssh://git@h:22/o/r.git', 'git@gitlab.com:g/p.git', 'file:///tmp/x.git', 'C:\\x\\y.git', '/tmp/x.git']) {
    assert.equal(Rules.checkRemoteUrl(ok), null, ok);
  }
});

test('normalizeRepoUrl ve repoProvider', () => {
  assert.deepEqual(Rules.normalizeRepoUrl('o/r'), { url: 'https://github.com/o/r.git', provider: 'github', slugName: 'r' });
  assert.equal(Rules.normalizeRepoUrl('  https://github.com/o/r/tree/main/  ').url, 'https://github.com/o/r.git');
  assert.equal(Rules.normalizeRepoUrl('https://gitlab.com/g/alt/p/-/tree/main').url, 'https://gitlab.com/g/alt/p.git');
  assert.equal(Rules.normalizeRepoUrl('https://gitlab.com/g/alt/p/-/tree/main').provider, 'gitlab');
  assert.equal(Rules.normalizeRepoUrl('https://git.firma.com/g/p').url, 'https://git.firma.com/g/p.git');
  assert.equal(Rules.normalizeRepoUrl('git@gitlab.com:g/p.git').slugName, 'p');
  assert.equal(Rules.normalizeRepoUrl('ext::sh -c x').error, 'Bu bağlantı türü güvenlik nedeniyle kapalı');
  assert.equal(Rules.normalizeRepoUrl('').error, 'URL gerekli');
  assert.equal(Rules.repoProvider('https://git.firma.com/g/p.git'), 'diger');
  assert.equal(Rules.repoProvider('https://gitlab.firma.com/g/p.git'), 'gitlab');
});

test('marketplaceAddCommand: GitHub kısaltma + tam URL, GitLab yalnızca tam URL', () => {
  assert.deepEqual(Rules.marketplaceAddCommand('https://github.com/o/r.git'), { primary: 'o/r', alternatives: ['https://github.com/o/r.git'] });
  assert.deepEqual(Rules.marketplaceAddCommand('https://gitlab.com/g/p.git'), { primary: 'https://gitlab.com/g/p.git', alternatives: [] });
});
