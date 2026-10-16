# Changelog

## 0.4.0

- Images. `decide` takes `assets`, a map of reference to image; the model sees the image wherever the reference appears in the state, a question's instructions or a criterion's description. Every asset must be referenced at least once.
- Image helpers that read PNG and JPEG files as they are (never resized): `Image.from_path` and `Image.from_bytes` in Python, `imageFromPath` (Node) and `imageFromBytes` in JavaScript. They detect the format from the file's first bytes and refuse anything else, or anything over 16 MiB, before sending. A plain object in the wire shape `{"type": "image", "format", "data_base64"}` is sent as it is.
- `image_budget` (Python) and `imageBudget` (JavaScript): 70, 140 or 280, the most visual tokens one image may use. Any other value raises `ValidationError`; when it is not given the server default (280) applies.
- In JavaScript the third argument of `decide` may now be options `{ model, assets, imageBudget }`; a model name still works.
- Image errors are `InvalidRequestError`s whose `type` says what was wrong: `invalid_assets`, `unsupported_image_format`, `invalid_image`, `image_too_large`, `image_dimensions`, `too_many_images`, `unreferenced_asset`, `image_reference_truncated` (400) or `invalid_image_budget` (422).

## 0.3.0

- `client.admin.keys` manages your organisation's API keys through the key management API: `list` (a page at a time, newest first), `listAll` / `list_all` (every key), `create`, `roll` and `revoke`. It needs an admin key, which an owner makes on the API keys page of the console.
- The admin key is a separate option (`adminKey` in JavaScript, `admin_key` in Python) or the `LAUNCHABLES_ADMIN_KEY` environment variable. It is sent only to the console, at `https://console.launchables.ai` by default (`adminBaseURL` / `admin_base_url` to change it), never to the Decision API.
- `NotFoundError` for HTTP 404 and `ConflictError` for HTTP 409. Both are kinds of `InvalidRequestError`, so existing handlers still catch them.
- Errors sent as `{"error": {"type", "message"}}` now give the message and `type` as well as errors sent as `{"error": "..."}`.
- `create` and `roll` are retried only after a 429, so a retry never makes a second key. Other calls retry as before.

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
