# Contributing

Thanks for your interest in Prompt havuzu. Bug reports, ideas and pull requests are welcome.

## Setup

You need Node.js 18 or newer and git. There is nothing to install.

```bash
git clone https://github.com/kaanturker61/prompt-havuzu.git
cd prompt-havuzu
node tools/ui/server.js --open
```

On first run, choose a library root outside the repository in **Ayarlar** (Settings). For experiments, point `PP_CONFIG=<file>` at a throwaway settings file so your real settings stay untouched.

## Tests

```bash
npm test --prefix tools/ui
```

Tests use `node:test` and `node:assert/strict`. Rules for tests:

- Use temporary folders and `PP_CONFIG` only. Never touch a real settings file, your real library or this repository's git state.
- Isolate git with `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM`, as the existing helpers do.
- Add or update tests for every behavior change.

## Code guidelines

- **No dependencies.** The project has no runtime dependencies and no build step. Do not add any; use Node.js built-ins.
- **Shared rules live in `tools/ui/public/rules.js`.** The server and the UI use the same module (as with `fm.js`). Do not re-implement naming, versioning or publish rules elsewhere.
- **Git only through `GitService`** (`tools/ui/lib/git-service.js`, `execFile`, no shell). Other modules must not run git commands.
- **File access goes through `safePath`**, writes through `atomicWrite`, deletes through `toTrash`.
- **New public files** served to the browser must be added to the allow-list in `tools/ui/server.js`.
- **UI language is Turkish.** Interface text, error messages, frontmatter keys and commit messages produced by the app are in Turkish; write new user-facing strings in Turkish. Code comments in the existing files are Turkish too. Documentation files such as this one are in English.

## Pull requests

1. Open an issue first for larger changes so the approach can be discussed.
2. Create a branch from the default branch and keep the change focused.
3. Run `npm test --prefix tools/ui` and make sure it passes.
4. Describe what changed and why, and include a screenshot for UI changes (use demo data, never real prompts or personal paths).
5. By contributing you agree that your work is released under the [MIT license](LICENSE).

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, see [SECURITY.md](SECURITY.md) instead of opening a public issue.
