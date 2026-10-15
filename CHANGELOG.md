# Changelog

## 0.2.0

- `key()` returns the calling key's details: id, name, expiry date and days left, rate and daily limits, and whether it is paused (with the reason). It counts as no request and no tokens.
- Every response's `Launchables-Key-Expires` header is read; the last value is on the client (`keyExpiry` in JavaScript, `key_expiry` in Python).
- `onKeyExpiry` (JavaScript) and `on_key_expiry` (Python) are called once per key and expiry date when 14 days or fewer are left. Without one, the client writes one console warning (JavaScript) or issues one `KeyExpiryWarning` (Python).
- `models()` sends the API key when one is set, so it also reports the key's expiry. It still works without a key.

## 0.1.1

- `OutOfCreditError` for HTTP 402: the account has run out of prepaid credit (`type` `"out_of_credit"`) or the key's workspace has reached its monthly budget (`type` `"budget_exceeded"`).
- `PermissionDeniedError` for HTTP 403: the key's workspace may not use the requested model (`type` `"model_not_allowed"`).
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
