'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const FM = require('../public/fm.js');
const Rules = require('../public/rules.js');
const { PromptIndex } = require('../lib/prompt-index');
const { tmpDir, rmrf } = require('./helpers');

const decode = (b) => b.toString('utf8');
const mkIndex = () => new PromptIndex({ decode, FM, Rules, ignore: new Set(Rules.RESERVED_DIRS) });
const put = (dir, rel, raw) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, raw); return f; };

test('aynı rel iki farklı kökte farklı meta döner', async () => {
  const d = tmpDir();
  try {
    const a = path.join(d, 'a'); const b = path.join(d, 'b');
    put(a, 'prompts/x/p.md', '---\nbaslik: Birinci\n---\ngovde');
    put(b, 'prompts/x/p.md', '---\nbaslik: Ikinci\n---\ngovde');
    const ix = mkIndex();
    const la = await ix.listMd(a, 'prompts');
    const lb = await ix.listMd(b, 'prompts');
    assert.equal(la[0].title, 'Birinci');
    assert.equal(lb[0].title, 'Ikinci');
    assert.equal((await ix.listMd(a, 'prompts'))[0].title, 'Birinci');
  } finally { rmrf(d); }
});

test('mtime/size değişince yeniden okunur', async () => {
  const d = tmpDir();
  try {
    const f = put(d, 'prompts/p.md', '---\nbaslik: Eski\n---\nx');
    const ix = mkIndex();
    assert.equal((await ix.listMd(d, 'prompts'))[0].title, 'Eski');
    fs.writeFileSync(f, '---\nbaslik: Yeni baslik\n---\nxyz');
    assert.equal((await ix.listMd(d, 'prompts'))[0].title, 'Yeni baslik');
  } finally { rmrf(d); }
});

test('silinen dosya önbellekten düşer; clear(dir) yalnızca o kökü temizler', async () => {
  const d = tmpDir();
  try {
    const a = path.join(d, 'a'); const b = path.join(d, 'b');
    const f = put(a, 'prompts/p.md', 'bir');
    put(b, 'prompts/p.md', 'iki');
    const ix = mkIndex();
    await ix.listMd(a, 'prompts'); await ix.listMd(b, 'prompts');
    assert.ok(ix._cache.get(a).has('prompts/p.md'));
    fs.rmSync(f);
    assert.equal((await ix.listMd(a, 'prompts')).length, 0);
    assert.equal(ix._cache.get(a).size, 0);
    ix.clear(b);
    assert.equal(ix._cache.has(b), false);
    assert.ok(ix._cache.has(a));
    ix.clear();
    assert.equal(ix._cache.size, 0);
  } finally { rmrf(d); }
});

test('IGNORE adları (tools dahil) yürüyüşte atlanır; listDirs', async () => {
  const d = tmpDir();
  try {
    put(d, 'prompts/ok/a.md', 'a');
    put(d, 'prompts/tools/b.md', 'b');
    const ix = mkIndex();
    assert.deepEqual((await ix.listMd(d, 'prompts')).map((i) => i.path), ['prompts/ok/a.md']);
    assert.deepEqual(await ix.listDirs(d, 'prompts'), ['prompts', 'prompts/ok']);
  } finally { rmrf(d); }
});
