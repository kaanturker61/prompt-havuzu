(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PP_LANG_EN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    'err.api.notFound': 'Not found',
    'err.settings.invalidValue': 'Invalid value',

    'ui.settings.language': 'Dil / Language',
    'ui.settings.languageAuto': 'Otomatik / Automatic',
    'ui.settings.languageTr': 'Türkçe',
    'ui.settings.languageEn': 'English (US)',
    'ui.settings.languageChanged': 'Language saved',

    'ui.static.title': 'Prompt havuzu',
    'ui.static.brand': 'Prompt havuzu',
    'ui.static.goActive': 'Go to the active marketplace in the tree',
    'ui.static.searchPlaceholder': 'Search prompts (Ctrl+K)',
    'ui.static.searchLabel': 'Search prompts',
    'ui.static.actionsLabel': 'Actions',
    'ui.static.newPrompt': 'New prompt',
    'ui.static.import': 'Import',
    'ui.static.git': 'Git',
    'ui.static.marketplace': 'Marketplace',
    'ui.static.settings': 'Settings',
    'ui.static.openList': 'Open prompt list',
    'ui.static.list': 'List',
    'ui.static.closeList': 'Close list',
    'ui.static.filterStatusLabel': 'Filter by status',
    'ui.static.allStatuses': 'All statuses',
    'ui.static.statusDraft': 'Draft',
    'ui.static.statusStable': 'Stable',
    'ui.static.statusArchived': 'Archived',
    'ui.static.filterTypeLabel': 'Filter by type',
    'ui.static.allTypes': 'All types',
    'ui.static.typeCommand': 'Command',
    'ui.static.typeAgent': 'Agent',
    'ui.static.typeSkill': 'Skill',
    'ui.static.notPublished': 'Not published',
    'ui.static.searchInFiles': 'Also search marketplace files (plugins/)',
    'ui.static.library': 'Library',
    'ui.static.clearFilters': 'Clear filter',
    'ui.static.libraryActions': 'Library actions',
    'ui.static.addMarketplace': '+ Marketplace',
    'ui.static.addPlugin': '+ Plugin',
    'ui.static.addPrompt': '+ Prompt',
    'ui.static.close': 'Close'
  };
});
