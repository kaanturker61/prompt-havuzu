'use strict';
/* Yeni marketplace iskelet dosyalarının içerikleri. */
const { DEFAULT_VERSION } = require('../public/rules.js');

const GITIGNORE = '.pp/\nnode_modules/\n*.pp-tmp\ndesktop.ini\n';
const GITATTRIBUTES = '*.md text eol=lf\n*.json text eol=lf\n';

function marketplaceJson({ name, description, owner }) {
  return JSON.stringify({ name, description, owner: { name: owner }, plugins: [] }, null, 2) + '\n';
}

function ppConfig({ name, description, owner }) {
  return JSON.stringify({
    libraryDir: 'prompts',
    marketplace: { name, owner, plugin: name, description, version: DEFAULT_VERSION },
    packages: {}
  }, null, 2) + '\n';
}

function readme(name) {
  return `# ${name}\n\nBu klasör Prompt Havuzu ile yönetilen bir Claude Code marketplace deposudur.\n\n- Promptlar \`prompts/\` altında \`.md\` dosyaları olarak tutulur.\n- \`plugins/\` ve \`.claude-plugin/\` arayüzden yayınlanınca üretilir, elle düzenlenmez.\n- İlk commit'i Prompt Havuzu'nun Git panelinden atabilirsin.\n`;
}

module.exports = { GITIGNORE, GITATTRIBUTES, marketplaceJson, ppConfig, readme };
