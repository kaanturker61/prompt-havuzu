'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UndoStack } = require('../lib/undo');

test('adımlar ters sırada çalışır', async () => {
  const u = new UndoStack(); const order = [];
  u.push(() => order.push(1)); u.push(async () => { order.push(2); }); u.push(() => order.push(3));
  await u.rollback();
  assert.deepEqual(order, [3, 2, 1]);
  assert.equal(u.size, 0);
});

test('bir adım hata verse de diğerleri çalışır, hatalar toplanır', async () => {
  const u = new UndoStack(); const order = [];
  u.push(() => order.push('a'));
  u.push(() => { throw new Error('x'); });
  u.push(async () => { throw new Error('y'); });
  u.push(() => order.push('d'));
  await assert.rejects(u.rollback(), (e) => {
    assert.ok(e instanceof AggregateError);
    assert.deepEqual(e.errors.map((x) => x.message), ['y', 'x']);
    return true;
  });
  assert.deepEqual(order, ['d', 'a']);
});

test('clear adımları unutur; fonksiyon olmayan reddedilir', async () => {
  const u = new UndoStack(); let n = 0;
  u.push(() => n++); u.clear(); await u.rollback();
  assert.equal(n, 0);
  assert.throws(() => u.push(1), TypeError);
});
