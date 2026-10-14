# Changelog

## 0.1.0

Initial release of the Python (`launchables` on PyPI) and JavaScript/TypeScript (`launchables` on npm) clients.

- `decide` for `noul`, `choice` and `score` questions, with typed answers.
- Question helpers `noul`, `choice`, `score` with local validation (types, up to 16 questions, up to 26 options).
- `NoulAnswer.decide` / `decide()` threshold helper returning `yes`, `no` or `person`.
- `models()` and `health()`.
- Error classes mapped to HTTP status codes.
- Retries with exponential backoff (0.5s, 1s, 2s) on 429, 502, 503 and connection errors, honouring `Retry-After`.
- Overridable base URL for self-hosted endpoints.
