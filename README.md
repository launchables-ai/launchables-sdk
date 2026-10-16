# Launchables SDKs

Client libraries for the Launchables Decision API: give it a state (text or JSON) and a few questions, get back calibrated probabilities you can act on.

| Language | Package | Directory |
| --- | --- | --- |
| Python 3.9+ | `pip install launchables` | [`python/`](python) |
| Node 18+ / TypeScript | `npm install launchables` | [`js/`](js) |

Both have no runtime dependencies, the same surface (`decide`, `noul`/`choice`/`score` helpers, `models`, `health`, `key`), the same error classes and the same retry rules. The API token is read from `LAUNCHABLES_API_TOKEN` by default. Keep it on a server, never in browser code.

Every key expires. Each response carries the key's expiry in the `Launchables-Key-Expires` header (and its id in `Launchables-Key-Id`), `GET /v1/key` returns the key's details, and both clients warn once when 14 days or fewer are left (see the Key expiry section of each client's README).

Questions can look at images: pass PNG or JPEG files in `assets` and name them in the state or the instructions (see the Images section of each client's README).

To rotate keys automatically, `client.admin.keys` lists, creates, rolls and revokes your organisation's keys with an admin key (`LAUNCHABLES_ADMIN_KEY`), which an owner makes in the console. See the Managing keys section of each client's README.

Equivalent raw request:

```
curl https://api.launchables.ai/v1/decide -H "Authorization: Bearer $LAUNCHABLES_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"state": "Customer bought the item 12 days ago and has no receipt. Policy: refunds within 30 days with proof of purchase.", "questions": {"refund": {"type": "noul", "instructions": "Is a refund permitted under the policy?"}}}'
```

## Development

```
cd python && PYTHONPATH=src python -m unittest discover -s tests -t .
cd js && npm install && npm test
```

Tests use mocked HTTP only; they never call the production API.

## Licence

Apache-2.0 (see [LICENSE](LICENSE)).
