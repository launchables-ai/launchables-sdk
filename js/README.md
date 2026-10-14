# launchables (JavaScript / TypeScript)

Client for the Launchables Decision API. ESM, TypeScript types included, no runtime dependencies, Node 18+ (uses the global `fetch`).

```
npm install launchables
```

> **Keep your API key on a server.** Never put it in browser code, a mobile app or any bundle shipped to users. The client refuses to construct in a browser unless you pass `dangerouslyAllowBrowser: true`. Call it from your backend.

## Quick start

```ts
import { Launchables, noul } from "launchables";

const client = new Launchables(); // reads LAUNCHABLES_API_TOKEN

const resp = await client.decide(
  "Customer bought the item 12 days ago and has no receipt. Policy: refunds within 30 days with proof of purchase.",
  { refund: noul("Is a refund permitted under the policy?") },
);

const answer = resp.answers.refund;
console.log(answer.probability);                                  // probability of yes, e.g. 0.04
console.log(answer.decide({ thresholdYes: 0.9, thresholdNo: 0.1 })); // "yes" | "no" | "person"
console.log(resp.usage.input_tokens, resp.model);
```

`decide(state, questions, model?)` returns `{ model, answers, usage, raw }`. `state` may be a string or an object. Answers are typed from the question you asked, so `resp.answers.refund` is a `NoulAnswer`.

### Question types

```ts
import { noul, choice, score } from "launchables";

const resp = await client.decide(state, {
  refund: noul("Is a refund permitted?", { true: "Policy clearly allows it", false: "Policy clearly forbids it" }),
  topic: choice("What is this about?", ["billing", "returns", "other"]),        // or { label: description }
  urgency: score("How urgent is it?", ["not urgent", "low", "medium", "high"]), // lowest level first, numbered from 0
});

resp.answers.topic.choice;          // "returns"
resp.answers.topic.probabilities;   // { billing: 0.06, returns: 0.89, ... }
resp.answers.urgency.level;         // 2
resp.answers.urgency.score;         // 1.92
```

The helpers validate locally and throw `ValidationError` before any request is sent: at most 16 questions per request, at most 26 options per choice, non-empty instructions.

### Other calls

```ts
await client.models(); // [{ id: "myles-g-12b", object: "model", owned_by: "launchables" }]
await client.health(); // { status: "ok" }
```

`models()` and `health()` need no token.

## Error handling

All errors extend `LaunchablesError` and carry `.status`, `.serverMessage`, `.body` and `.type` (the server's error type, such as `"out_of_credit"`, or `null` if it sent none).

| Error | When |
| --- | --- |
| `AuthenticationError` | 401, or no key given or found |
| `OutOfCreditError` | 402: the account has run out of prepaid credit (`.type` `"out_of_credit"`, top up in the console), or the key's project has reached its monthly budget (`.type` `"budget_exceeded"`) |
| `PermissionDeniedError` | 403: the key's project may not use this model (`.type` `"model_not_allowed"`) |
| `RateLimitError` | 429 (`.retryAfter` seconds, if sent) |
| `InvalidRequestError` | 400, 411, 413, 422 and other 4xx; `ValidationError` is the local pre-flight subclass |
| `APIError` | 5xx |
| `APIConnectionError` | could not reach the server (including timeouts) |

```ts
import { OutOfCreditError, RateLimitError, InvalidRequestError, LaunchablesError } from "launchables";

try {
  await client.decide(state, questions);
} catch (e) {
  if (e instanceof OutOfCreditError) console.log(e.type === "budget_exceeded" ? "project budget reached" : "top up credit");
  else if (e instanceof RateLimitError) console.log("slow down", e.retryAfter);
  else if (e instanceof InvalidRequestError) console.log(e.status, e.serverMessage);
  else if (e instanceof LaunchablesError) console.log("failed:", e.message);
  else throw e;
}
```

## Retries

429, 502, 503 and connection errors are retried up to `maxRetries` times (default 3) with exponential backoff of 0.5s, 1s, 2s. A `Retry-After` header (seconds) is honoured instead, capped at 60s. Other errors, including 402 and 403, are thrown immediately. `timeout` is in milliseconds (default 30000) and applies to each attempt.

```ts
const client = new Launchables({ apiKey: "launchables_...", timeout: 10_000, maxRetries: 5 });
```

## Self-hosted endpoints

```ts
const client = new Launchables({ baseURL: "https://decisions.internal.example.com" });
```

Requests carry `User-Agent: launchables-js/<version>`. (Some runtimes, including browsers, ignore this header.)

## Development

```
npm install
npm test   # builds dist/ then runs node:test against a mocked fetch
```
