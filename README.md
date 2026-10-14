# Launchables SDKs

Client libraries for the Launchables Decision API: give it a state (text or JSON) and a few questions, get back calibrated probabilities you can act on.

| Language | Package | Directory |
| --- | --- | --- |
| Python 3.9+ | `pip install launchables` | [`python/`](python) |
| Node 18+ / TypeScript | `npm install launchables` | [`js/`](js) |

Both have no runtime dependencies, the same surface (`decide`, `noul`/`choice`/`score` helpers, `models`, `health`), the same error classes and the same retry rules. The API token is read from `LAUNCHABLES_API_TOKEN` by default. Keep it on a server, never in browser code.

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
