(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PP_LANG_EN = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  return {
    'err.api.notFound': 'Not found'
  };
});
