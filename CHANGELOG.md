# Changelog

## Unreleased

- The API no longer keeps a copy of a live answer once it has been sent, so a repeated request is no longer answered with the original answer. A repeat of a request that was already answered, with the same `Idempotency-Key`, is refused with 409 `idempotency_key_already_used`: nothing is answered or billed again. The clients now raise `IdempotencyKeyAlreadyUsedError` for it (a subclass of `ConflictError`, so existing handlers still catch it) and never retry it. It carries the answered request's id (`request_id` in Python, `requestId` in JavaScript) and, for a batch submission, the batch that was created (`batch_id` / `batchId`; follow it with `batches.retrieve`). If an answer was lost, send the request again with a new key; it is then answered, and billed, as a new request. This can also follow a lost connection or a wait on `idempotency_in_progress`, where the retry used to return the original answer.
- Batch results can be downloaded once. They are deleted as soon as they have been sent in full, and results never downloaded are deleted 24 hours after the batch finished. A later `results` or `stream_results` / `streamResults` call raises `BatchResultsDeletedError` (410 `batch_results_deleted`, a subclass of `InvalidRequestError`), which says when the results were deleted (`results_deleted_at` / `resultsDeletedAt`). A batch's status has a new `results_deleted_at` field.
- For these two errors the error message is the client's explanation of what to do next; the server's own message is kept in `server_message` (Python) and `serverMessage` (JavaScript).
- The READMEs no longer describe replayed answers.

## 0.7.0

- Retries are never billed twice. Every `decide` call and batch submission now sends an `Idempotency-Key` header, a random UUID per call, the same on every retry of that call, so a request the API already answered (but whose answer was lost to a timeout or a dropped connection) is returned again instead of answered and billed a second time. Pass your own key with `idempotency_key` (Python) or `idempotencyKey` (JavaScript) to make a request safe to repeat across restarts; a key is 1 to 255 printable ASCII characters.
- A 409 `idempotency_in_progress` (an earlier attempt with the same key is still being answered) is waited out, honouring `Retry-After`, for up to 150 seconds without using up the retry budget; then `ConflictError`. A 422 `idempotency_key_reused` (the same key with a different request) is raised at once as `InvalidRequestError`.
- JavaScript: `IDEMPOTENCY_HEADER` is exported.

## 0.6.0

- Wider requests: the client-side checks now allow up to 256 questions a request, 256 options a choice and 4,096 options over a request, the API's largest limits (Myles-G 12B since 24 Oct 2026). A model on lower limits (Myles-G 31B: 16 questions, 26 options) still answers 422 with `too_many_questions` or `too_many_options`.

## 0.5.0

- The Batch API, in both clients. `client.batch(lines)` (or `client.batches.create`) submits many decisions as one JSONL file, answered within 24 hours at half the live price per input token; `batches.list`, `retrieve`, `cancel`, `results`, a streaming results reader (`streamResults` in JavaScript, `stream_results` in Python) and `waitFor` / `wait_for`, which polls with growing waits (5 s, 1.5 times longer each time, up to 60 s), gives up after 25 hours and can be stopped early (an `AbortSignal` in JavaScript, a `threading.Event` in Python). A webhook address is `webhookUrl` / `webhook_url`. Every line is checked before sending, names its own model and carries a `custom_id`; results are typed as `decide`'s answers. A submission is retried only after a refusal that stored nothing, so a retry never makes two batches.
- `ConflictError` and `NotFoundError` also come from the Batch API (409 `batch_not_finished` or `batch_finished`, 404 `batch_not_found`). A 503 `batch_unavailable` is not retried. New errors: `BatchTimeoutError` (both) and `BatchWaitCancelledError` (Python; in JavaScript `waitFor` rejects with the signal's reason).
- Always name the model on `decide` (and on every batch line). The API is moving to requiring it; until then a request without one is answered by the server's default model, which can change. The examples and docs now pass it everywhere.
- Python: a response body that breaks off part-way is now a connection error, retried like one (as in JavaScript).

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
