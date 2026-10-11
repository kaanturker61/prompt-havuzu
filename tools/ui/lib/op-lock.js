'use strict';
/* Git'e yazan (yaz) ve ağ kullanan (ag) işlemler için marketplace klasörüne göre kilit.
 * İki tür birbirini engellemez: uzun süren bir arka plan fetch'i yayını bloklamaz.
 * Kilit doluysa BusyError (409, busy: true) fırlatılır; kuyruk yoktur. */

class BusyError extends Error {
  constructor() {
    super('Başka bir git işlemi sürüyor, bitmesini bekle');
    this.name = 'BusyError';
    this.status = 409;
    this.data = { busy: true };
  }
}

class OpLock {
  constructor() { this._held = new Set(); }

  isBusy(dir, kind) { return this._held.has(dir + '\0' + kind); }

  async run(dir, kind, fn) {
    const key = dir + '\0' + kind;
    if (this._held.has(key)) throw new BusyError();
    this._held.add(key);
    try { return await fn(); } finally { this._held.delete(key); }
  }
}

module.exports = { OpLock, BusyError };
