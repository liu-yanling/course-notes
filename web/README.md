# course notes · Web MVP

Public, stateless web version of course notes. Paste a Bilibili video URL and
get a summarized Markdown note plus a Word download.

This is deliberately separate from the local macOS app:

- no browser tab detection (manual URL only)
- no local note directory
- no Keychain / local control API
- no accounts or persistent database
- only an in-memory rate limiter

## Run locally

~~~sh
PORT=43210 node web/server.mjs
# open http://127.0.0.1:43210
~~~

Python 3 + python-docx is needed for the Word button. Point at a working
interpreter with:

~~~sh
COURSE_NOTES_PYTHON=/path/to/python3 PORT=43210 node web/server.mjs
~~~

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| PORT | 10000 | HTTP port |
| COURSE_NOTES_PYTHON | python3 | interpreter with python-docx |
| DEEPSEEK_BASE_URL | https://api.deepseek.com/v1 | DeepSeek-compatible API |
| DEEPSEEK_MODEL | deepseek-chat | model name |
| WEB_RATE_LIMIT | 8 | requests per IP per 10 minutes |

The DeepSeek key is entered by the user in the browser, sent only to this
server for that request, and never logged or persisted. Without a key the app
uses deterministic local extraction.

## Deploy on Render

The repository includes:

- [Dockerfile.web](../Dockerfile.web)
- [render.yaml](../render.yaml)

Click **Deploy to Render** and select the repository:

https://render.com/deploy?repo=https://github.com/liu-yanling/course-notes

Render will read render.yaml, build the Docker image, and expose a public URL.

## Limitations

- Bilibili may block datacenter IPs or rate-limit requests.
- The free Render plan can sleep; first request may be slow.
- No accounts, history or multi-user storage.
- Word generation depends on Python in the container.
- This is not a replacement for the local macOS app's automatic detection,
  subject manuals or local-first storage.
