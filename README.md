# course notes

> Turn the Bilibili course you are watching into a local, reviewable knowledge note.

[![License: MIT](https://img.shields.io/badge/License-MIT-4f46e5.svg)](LICENSE)
[![macOS 12+](https://img.shields.io/badge/macOS-12%2B-1f1d1a.svg)]
[![Node 22](https://img.shields.io/badge/Node.js-22-339933.svg)]

course notes is a local-first macOS desktop app for Bilibili learners. It watches
the course in your frontmost browser tab, classifies the subject, reads public
metadata / chapters / danmaku / comments, and produces a Markdown summary plus
Word notes and a subject study manual.

No account, no cloud upload of videos, and no requirement to keep a separate
agent runtime running.

![course notes home](docs/course-notes-首页.png)

## Features

- **Automatic detection** — watches Chrome, Safari or Tabbit for a Bilibili course.
- **Streaming summary** — classify → fetch → summarize → Word, with live progress.
- **Knowledge map** — notes are grouped by subject and merged into a study manual.
- **Word output** — .docx video note, subject manual, course overview.
- **Local first** — data stays in a local folder; only text needed for summarization goes to the LLM you choose.
- **Bring your own key** — DeepSeek API, local Ollama, or a deterministic local extractor.
- **macOS Keychain** — API keys are stored in Keychain instead of plain config when available.
- **Menu bar helper** — open the app, poll now, pause, open notes, launch at login.
- **Update check** — reads a configurable version.json manifest.
- **Website** — [liu-yanling.github.io/course-notes](https://liu-yanling.github.io/course-notes/); source in [site/](site/).

## Status

1.0.0-beta · Apple Silicon macOS · ad-hoc signed, **not notarized**.
The source is MIT-licensed. Binary beta builds are published in
[GitHub Releases](https://github.com/liu-yanling/course-notes/releases).

## Quick start (from source)

Requirements:

- macOS 12+ (Apple Silicon for the bundled beta build)
- Node.js 22+
- Python 3.12 + [python-docx] if you want Word output
- Chrome or Safari / Tabbit for browser detection

~~~sh
git clone https://github.com/liu-yanling/course-notes.git
cd course-notes
npm test
node server/index.mjs --open
~~~

The browser opens http://127.0.0.1:43110. Data defaults to
~/Documents/course notes. In Settings, choose DeepSeek / Ollama / local
extraction and add your key.

If Python is not in a standard location, point the app at an interpreter that
can import docx:

~~~sh
COURSE_NOTES_PYTHON=/path/to/python3 node server/index.mjs --open
~~~

## How it works

~~~text
frontmost browser
      │  Chrome/Safari/Tabbit detection
      ▼
Bilibili public data
  title · owner · tags · pages · subtitle · danmaku · comments
      │
      ▼
classify subject → summarize (streaming) → merge study manual
      │
      ▼
Markdown + .docx in ~/Documents/course notes/课程知识地图
~~~

### Layout

~~~text
server/                  standalone HTTP + SSE backend and pipeline
public/                  vanilla HTML/CSS/JS frontend (no build step)
apps/dsh-video-coursemap/  reusable Node engine (detect, fetch, summarize, docx)
desktop/menu/            Swift menu-bar helper
scripts/                 icon, desktop app, beta build
site/                    static landing / privacy / terms
docs/                    screenshots and guides
~~~

## API surface

The app is a local HTTP server. Useful endpoints:

| Endpoint | Purpose |
| --- | --- |
| GET /api/status | polling state, current window, task, config |
| GET /api/events | SSE stream (task, summary chunks, completion) |
| POST /api/control | start, stop, pollNow, scan, shutdown |
| GET /api/history | subjects and videos |
| GET /api/video?key=... | one video note |
| POST /api/config | update settings |
| POST /api/llm/key | save/delete key in Keychain |
| GET /api/update | check the configured version manifest |

## Build a macOS app (optional)

The beta builder bundles a Node runtime and a Python runtime so end users do not
need either installed. It requires macOS, Xcode command-line tools and Swift.

~~~sh
# point at runtimes if they are not in standard locations
export COURSE_NOTES_NODE=/path/to/node
export COURSE_NOTES_PYTHON_ROOT=/path/to/python-runtime

node scripts/build-beta.mjs
# output: dist/Course Notes.app and dist/course-notes-*.zip
~~~

The helper at desktop/menu/CourseNotesMenu.swift is compiled into the app and
provides the menu-bar controls. Login-at-startup uses a per-user LaunchAgent
(~/Library/LaunchAgents/com.coursenotes.menu.plist).

## Privacy and security

- Video files are never uploaded. Only text needed for summarization is sent to
  the LLM you configure.
- Notes and state live in your local data directory.
- Keys are stored in macOS Keychain when available; the settings UI never reads
  a key back into the page.
- If Keychain is unavailable (for example in a restricted automation sandbox),
  the app reports it and can fall back to a local config file. See
  [SECURITY.md](SECURITY.md).
- Do not commit config.json, server/config.json, runtime files or the
  课程知识地图 output directory.

## Releases

Tagging a commit with v* triggers .github/workflows/release.yml. The workflow
runs the tests, downloads a relocatable Python, builds a self-contained macOS
app (bundled Node + Python), uploads the zip as an artifact, and publishes a
GitHub Release. It can also be run manually from the Actions tab with
workflow_dispatch (publish=false by default).

The build is ad-hoc signed and not notarized. See INSTALL.txt for end-user
installation notes.

## Testing

~~~sh
npm test
~~~

This runs 20 backend tests and 39 engine tests. The engine tests also exercise
the Python/docx bridge when a compatible interpreter is available.

## Relationship to DeepSeek Harness

The standalone app reuses the pure Node engine under
apps/dsh-video-coursemap/lib. It does not require the DSH process. An optional
DSH plugin installer is kept under apps/dsh-video-coursemap/scripts for users
who also want the original in-DSH workflow.

## Contributing

Issues and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md). For security reports, use the process in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 liu-yanling and course notes contributors.

[python-docx]: https://python-docx.readthedocs.io/
