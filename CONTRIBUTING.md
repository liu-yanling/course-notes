# Contributing

Thanks for helping improve course notes.

## Development

~~~sh
git clone https://github.com/liu-yanling/course-notes.git
cd course-notes
npm test
node server/index.mjs --open
~~~

Requirements: Node.js 22+, macOS for app packaging, Python 3.12 + python-docx
for Word output.

## Before opening a PR

- Run npm test (20 backend tests + 39 engine tests).
- Keep the frontend dependency-free: plain HTML/CSS/JS, no build step.
- Do not commit generated data, app bundles, runtime binaries, API keys or the
  local note directory.
- Keep user-visible strings in Chinese consistent with the existing UI.
- If you change the local HTTP API, update README.md and add a backend test.

## Reporting bugs

Include:

- macOS and browser versions
- the Bilibili URL (or a minimal reproduction)
- whether the issue happens in Chrome, Safari or Tabbit
- the relevant server log line, if safe to share

Never paste API keys, .p8 files or full Keychain dumps into an issue.

## License

By contributing you agree that your contribution is licensed under the MIT
License in LICENSE.
