(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PP_LANG_TR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    'err.api.notFound': 'Bulunamadı',
    'err.settings.invalidValue': 'Geçersiz değer',

    'ui.settings.language': 'Dil / Language',
    'ui.settings.languageAuto': 'Otomatik / Automatic',
    'ui.settings.languageTr': 'Türkçe',
    'ui.settings.languageEn': 'English (US)',
    'ui.settings.languageChanged': 'Dil kaydedildi',

    'ui.static.title': 'Prompt havuzu',
    'ui.static.brand': 'Prompt havuzu',
    'ui.static.goActive': "Ağaçta etkin marketplace'e git",
    'ui.static.searchPlaceholder': 'Prompt ara (Ctrl+K)',
    'ui.static.searchLabel': 'Prompt ara',
    'ui.static.actionsLabel': 'İşlemler',
    'ui.static.newPrompt': 'Yeni prompt',
    'ui.static.import': 'İçe aktar',
    'ui.static.git': 'Git',
    'ui.static.marketplace': 'Marketplace',
    'ui.static.settings': 'Ayarlar',
    'ui.static.openList': 'Prompt listesini aç',
    'ui.static.list': 'Liste',
    'ui.static.closeList': 'Listeyi kapat',
    'ui.static.filterStatusLabel': 'Duruma göre filtrele',
    'ui.static.allStatuses': 'Tüm durumlar',
    'ui.static.statusDraft': 'Taslak',
    'ui.static.statusStable': 'Kararlı',
    'ui.static.statusArchived': 'Arşiv',
    'ui.static.filterTypeLabel': 'Türe göre filtrele',
    'ui.static.allTypes': 'Tüm türler',
    'ui.static.typeCommand': 'Komut',
    'ui.static.typeAgent': 'Ajan',
    'ui.static.typeSkill': 'Skill',
    'ui.static.notPublished': 'Yayın dışı',
    'ui.static.searchInFiles': 'Marketplace dosyalarında da ara (plugins/)',
    'ui.static.library': 'Kütüphane',
    'ui.static.clearFilters': 'Filtreyi temizle',
    'ui.static.libraryActions': 'Kütüphane işlemleri',
    'ui.static.addMarketplace': '+ Marketplace',
    'ui.static.addPlugin': '+ Plugin',
    'ui.static.addPrompt': '+ Prompt',
    'ui.static.close': 'Kapat'
  };
});
