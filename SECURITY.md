# Security Policy

## Supported versions

Only the latest commit on the default branch is supported.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Use GitHub's **Private vulnerability reporting**: open the repository's **Security** tab and choose **Report a vulnerability**. If that option is not available, contact the repository owner through their GitHub profile and ask for a private channel before sharing details.

Please include:

- what you found and its impact,
- steps to reproduce, ideally with a minimal example,
- the operating system and Node.js version.

You can expect an acknowledgement and a follow-up on the fix. Please allow reasonable time for a fix before public disclosure.

## Scope

Prompt havuzu is a local tool. By design the server listens on `127.0.0.1` only, checks the `Host` header, requires the `X-PP: 1` header and a matching `Origin` for non-GET API requests, serves only an explicit allowlist of static files (no remote assets), and confines file access to the active marketplace folder. Reports about bypassing these protections, path traversal, command injection through git calls, or leaking data off the machine are in scope.
