# Changelog

## 0.1.1

- `OutOfCreditError` for HTTP 402: the account has run out of prepaid credit (`type` `"out_of_credit"`) or the key's project has reached its monthly budget (`type` `"budget_exceeded"`).
- `PermissionDeniedError` for HTTP 403: the key's project may not use the requested model (`type` `"model_not_allowed"`).
- Every API error now exposes the server's error type as `type` (`null` / `None` when the server sends none).
- 402 and 403 are not retried.

## 0.1.0

Initial release of the Python (`launchables` on PyPI) and JavaScript/TypeScript (`launchables` on npm) clients.

- `decide` for `noul`, `choice` and `score` questions, with typed answers.
- Question helpers `noul`, `choice`, `score` with local validation (types, up to 16 questions, up to 26 options).
- `NoulAnswer.decide` / `decide()` threshold helper returning `yes`, `no` or `person`.
- `models()` and `health()`.
- Error classes mapped to HTTP status codes.
- Retries with exponential backoff (0.5s, 1s, 2s) on 429, 502, 503 and connection errors, honouring `Retry-After`.
- Overridable base URL for self-hosted endpoints.
