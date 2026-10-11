'use strict';
/* Ağ hatası kodlarının Türkçe iletileri (push, fetch, clone ortak kullanır). */

function isSshUrl(url) {
  const s = String(url || '');
  return /^ssh:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

// code: GitService.classifyGitNetError çıktısı. opts: { url, dir }
function describeNetError(code, opts = {}) {
  const dir = opts.dir || '<klasör>';
  switch (code) {
    case 'kimlik':
      return isSshUrl(opts.url)
        ? 'SSH anahtarı kullanılamadı: anahtar ssh-agent\'a yüklü olmalı, parola sormamalı ve sunucu known_hosts içinde olmalı.'
        : 'Uzak depo kimlik doğrulaması başarısız. Bu araç parola soramaz. Kimlik bilgini bir kez kaydet: GitHub için "gh auth login" + "gh auth setup-git", GitLab için Git Credential Manager ile terminalde bir kez "git -C ' + dir + ' fetch" çalıştırıp giriş yap.';
    case 'ag': return 'Uzak depoya ulaşılamadı. Ağ bağlantısını ve URL\'yi kontrol et.';
    case 'bulunamadi': return 'Depo bulunamadı ya da erişim iznin yok.';
    case 'reddedildi':
      return 'Uzak depoda yerelde olmayan commit\'ler var. Önce "Kontrol et", sonra "Güncelle" (yalnızca ileri sarma) ya da terminalde "git -C ' + dir + ' pull --rebase".';
    case 'zamanAsimi': return 'İşlem zamanında tamamlanmadı. Bir kimlik bilgisi penceresi açık kalmış olabilir.';
    case 'mesgul': return 'Başka bir git işlemi sürüyor, bitmesini bekle.';
    case 'atomikYok': return 'Uzak sunucu atomik push desteklemiyor.';
    default: return 'Uzak depo işlemi başarısız oldu.';
  }
}

module.exports = { describeNetError, isSshUrl };
