'use strict';
/* Geri alma adımları yığını. Adımlar ters sırada çalışır; biri hata verse de diğerleri çalışır. */

class UndoStack {
  constructor() { this._steps = []; }

  get size() { return this._steps.length; }

  push(fn) {
    if (typeof fn !== 'function') throw new TypeError('Geri alma adımı bir fonksiyon olmalı');
    this._steps.push(fn);
  }

  // Hata olursa tümü AggregateError içinde toplanıp fırlatılır.
  async rollback() {
    const errors = [];
    while (this._steps.length) {
      const fn = this._steps.pop();
      try { await fn(); } catch (e) { errors.push(e); }
    }
    if (errors.length) throw new AggregateError(errors, 'Geri alma sırasında ' + errors.length + ' adım başarısız oldu');
  }

  // Başarı durumunda adımlar unutulur.
  clear() { this._steps.length = 0; }
}

module.exports = { UndoStack };
