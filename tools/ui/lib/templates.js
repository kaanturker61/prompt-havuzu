'use strict';
/* Yeni marketplace iskelet dosyalarının içerikleri. */
const I18n = require('../public/i18n.js');

/** Summary: Geçerli dilde düz metin çevirisi (istek bağlamındaki dil). */
const tx = I18n.tx;

const GITIGNORE = '.pp/\nnode_modules/\n*.pp-tmp\ndesktop.ini\n';
const GITATTRIBUTES = '*.md text eol=lf\n*.json text eol=lf\n';

function marketplaceJson({ name, description, owner }) {
  return JSON.stringify({ name, description, owner: { name: owner }, plugins: [] }, null, 2) + '\n';
}

function readme(name) {
  return tx('scaffold.readme', { name });
}

/** Summary: Açıklaması verilmeyen yeni marketplace için varsayılan açıklama (oluşturma anındaki dilde). */
function defaultDescription(slug) {
  return tx('scaffold.defaultDescription', { slug });
}

module.exports = { GITIGNORE, GITATTRIBUTES, marketplaceJson, readme, defaultDescription };
