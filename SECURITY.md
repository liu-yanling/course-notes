# Security policy

## Supported versions

The latest beta on the main branch is supported on a best-effort basis.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting / Security Advisories for
this repository instead of a public issue. If that is unavailable, open a
minimal issue asking for a private channel and do not include exploit details.

Do not include API keys, Keychain contents or personal data in reports.

## Local security model

- The HTTP server binds to 127.0.0.1 only and rejects cross-origin browser requests.
- Videos are not uploaded; only text needed for summarization goes to the
  configured LLM.
- API keys are stored in macOS Keychain when available.
- In restricted sandboxes Keychain writes can fail; the app reports this and
  may fall back to a local config file. Do not run the app in an untrusted
  multi-user environment with a shared Keychain/config.
- The app is ad-hoc signed and not notarized; install only builds you trust.
