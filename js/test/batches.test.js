import test from "node:test";
import assert from "node:assert/strict";
import {
  Launchables, noul, choice, NoulAnswer, toJSONL, BatchTimeoutError,
  APIError, APIConnectionError, ConflictError, InvalidRequestError, NotFoundError, RateLimitError, ValidationError,
  IdempotencyKeyAlreadyUsedError, BatchResultsDeletedError,
} from "../dist/index.js";

const ID = "batch_0123456789abcdef01234567";

/** Mock fetch replaying a script of [status, body, headers] (a body may be a ReadableStream) or Errors. */
function setup(script, opts = {}) {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init });
    const next = script.shift() ?? [200, {}];
    if (next instanceof Error) throw next;
    const [status, body, headers] = next;
    const payload = body instanceof ReadableStream || typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, { status, headers });
  };
  const client = new Launchables({
    apiKey: "launchables_test", baseURL: "https://example.test", fetch,
    sleep: async (ms) => { sleeps.push(ms); }, ...opts,
  });
  return { client, calls, sleeps };
}

const line = (id, extra = {}) => ({
  custom_id: id, model: "myles-g-12b", state: "Charged twice for order 4471",
  questions: { refund: noul("Is a refund due?") }, ...extra,
});
const CREATED = {
  id: ID, object: "batch", status: "queued", lines: 2, expires_at: "2026-10-20T12:00:00+00:00", data_region: "Canada",
  estimated_cost: { amount: 0.0000012, currency: "GBP", input_tokens: 1600, rate: 0.5, basis: "estimate" },
};
const status = (s, counts, lines = 2) => ({
  id: ID, object: "batch", status: s, lines, counts, models: ["myles-g-12b"], created_at: "2026-10-19T12:00:00+00:00",
  started_at: null, finished_at: null, expires_at: "2026-10-20T12:00:00+00:00", reason: null,
  results_available: ["done", "failed", "cancelled"].includes(s), webhook: false, estimated_cost: CREATED.estimated_cost,
  data_region: "Canada", delete_after: null,
});
const ANSWERED = {
  custom_id: "a", model: "myles-g-12b-20261017", status: 200,
  response: { model: "myles-g-12b-20261017", answers: { refund: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 120, output_tokens: 1 } },
  usage: { input_tokens: 120, output_tokens: 1, batch: true },
};
const EXPIRED = {
  custom_id: "b", model: "myles-g-12b", status: null, error: { type: "expired", error: "this line was not run (expired)" },
  usage: { input_tokens: 0, output_tokens: 0, batch: true },
};
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("create sends the lines as JSONL, one decide body per line", async () => {
  const { client, calls } = setup([[200, CREATED]]);
  const made = await client.batches.create([line("a"), line("b", { model: "myles-g-31b", questions: { team: choice("Which team?", ["billing", "other"]) } })]);
  assert.deepEqual(made, CREATED);
  const c = calls[0];
  assert.equal(c.url, "https://example.test/v1/batches");
  assert.equal(c.method, "POST");
  assert.equal(c.headers["Content-Type"], "application/jsonl");
  assert.equal(c.headers.Authorization, "Bearer launchables_test");
  assert.equal(c.headers["Launchables-Webhook-Url"], undefined);
  const rows = c.body.trimEnd().split("\n").map((r) => JSON.parse(r));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { custom_id: "a", model: "myles-g-12b", state: "Charged twice for order 4471", questions: { refund: { type: "noul", instructions: "Is a refund due?" } } });
  assert.equal(rows[1].model, "myles-g-31b");
  assert.ok(c.body.endsWith("\n"));
});

test("batch() is create(); a webhook goes in its header", async () => {
  const { client, calls } = setup([[200, CREATED]]);
  await client.batch([line("a")], { webhookUrl: "https://hooks.example.com/batches?team=ops" });
  assert.equal(calls[0].url, "https://example.test/v1/batches");
  assert.equal(calls[0].headers["Launchables-Webhook-Url"], "https://hooks.example.com/batches?team=ops");
});

test("a newline inside a state stays inside its line", () => {
  const body = toJSONL([line("a", { state: "first\nsecond" })]);
  assert.equal(body.split("\n").length, 2); // one line and the final newline
  assert.equal(JSON.parse(body.split("\n")[0]).state, "first\nsecond");
});

for (const [name, lines, pattern] of [
  ["no lines", [], /at least one line/],
  ["not an array", "a", /at least one line/],
  ["no model", [{ ...line("a"), model: undefined }], /line 1 \(custom_id a\): every line names its model/],
  ["empty model", [line("a", { model: "" })], /names its model/],
  ["bad custom_id", [line("has space")], /line 1: custom_id must be/],
  ["long custom_id", [line("x".repeat(65))], /custom_id must be/],
  ["duplicate custom_id", [line("a"), line("a")], /line 2 \(custom_id a\): custom_id is used on an earlier line/],
  ["array state", [line("a", { state: [] })], /state must be a string or a JSON object/],
  ["no questions", [line("a", { questions: {} })], /line 1 \(custom_id a\): questions must be a non-empty object/],
  ["bad question", [line("a", { questions: { q: { type: "maybe", instructions: "x" } } })], /type must be one of/],
  ["file part image", [line("a", { assets: { r: { type: "image", format: "png", part: "r" } } })], /must be inline \(data_base64\)/],
  ["bad image budget", [line("a", { image_budget: 100 })], /imageBudget must be one of/],
]) {
  test(`create refuses before sending: ${name}`, async () => {
    const { client, calls } = setup([]);
    await assert.rejects(client.batches.create(lines), (e) => e instanceof ValidationError && pattern.test(e.message));
    assert.equal(calls.length, 0);
  });
}

test("create refuses a webhook that is not https before sending", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.batches.create([line("a")], { webhookUrl: "http://hooks.example.com" }), ValidationError);
  assert.equal(calls.length, 0);
});

test("an invalid batch is refused whole, with every bad line listed", async () => {
  const errors = [{ line: 2, type: "model_not_found", error: "model 'x' not found" }];
  const { client } = setup([[422, { error: "1 invalid line(s); nothing was queued", type: "invalid_batch", errors, invalid_lines: 1 }]]);
  await assert.rejects(client.batches.create([line("a")]), (e) => {
    assert.ok(e instanceof InvalidRequestError);
    assert.equal(e.type, "invalid_batch");
    assert.deepEqual(e.body.errors, errors);
    return true;
  });
});

test("create is never retried after a lost connection or a 502, so a retry cannot make two batches", async () => {
  const a = setup([new TypeError("fetch failed")]);
  await assert.rejects(a.client.batches.create([line("a")]), APIConnectionError);
  assert.equal(a.calls.length, 1);
  const b = setup([[502, { error: "bad gateway" }]]);
  await assert.rejects(b.client.batches.create([line("a")]), APIError);
  assert.equal(b.calls.length, 1);
});

test("create is retried after a refusal that stored nothing (rate_limited, busy)", async () => {
  const { client, calls, sleeps } = setup([
    [429, { error: "rate limit", type: "rate_limited", retry_after: 2 }, { "Retry-After": "2" }],
    [503, { error: "busy", type: "busy" }],
    [200, CREATED],
  ]);
  assert.equal((await client.batches.create([line("a")])).id, ID);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [2000, 1000]);
});

test("too many open batches is thrown at once, with the wait", async () => {
  const { client, calls } = setup([[429, { error: "at most 10 batches", type: "too_many_batches", retry_after: 300 }, { "Retry-After": "300" }]]);
  await assert.rejects(client.batches.create([line("a")]), (e) => e instanceof RateLimitError && e.type === "too_many_batches" && e.retryAfter === 300);
  assert.equal(calls.length, 1);
});

test("batch_unavailable is never retried", async () => {
  const { client, calls } = setup([[503, { error: "the batch API is not available on this server", type: "batch_unavailable", retry_after: 3600 }, { "Retry-After": "3600" }]]);
  await assert.rejects(client.batches.list(), (e) => e instanceof APIError && e.type === "batch_unavailable");
  assert.equal(calls.length, 1);
});

test("list, retrieve and cancel", async () => {
  const { client, calls } = setup([
    [200, { object: "list", data: [status("queued", { done: 0, failed: 0, pending: 2 })] }],
    [200, status("running", { done: 1, failed: 0, pending: 1 })],
    [200, status("cancelled", { done: 1, failed: 0, pending: 0 })],
  ]);
  assert.equal((await client.batches.list())[0].id, ID);
  assert.equal((await client.batches.retrieve(ID)).counts.done, 1);
  assert.equal((await client.batches.cancel(ID)).status, "cancelled");
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ["GET", "https://example.test/v1/batches"],
    ["GET", `https://example.test/v1/batches/${ID}`],
    ["POST", `https://example.test/v1/batches/${ID}/cancel`],
  ]);
  assert.equal(calls[2].body, undefined);
});

test("status calls are retried like any read", async () => {
  const { client, calls } = setup([[502, { error: "x" }], [200, status("queued", { done: 0, failed: 0, pending: 2 })]]);
  assert.equal((await client.batches.retrieve(ID)).status, "queued");
  assert.equal(calls.length, 2);
});

test("ids are checked before sending; an unknown id is NotFoundError", async () => {
  const { client, calls } = setup([[404, { error: "batch not found", type: "batch_not_found" }]]);
  await assert.rejects(client.batches.retrieve("../v1/key"), ValidationError);
  await assert.rejects(client.batches.cancel(""), ValidationError);
  assert.equal(calls.length, 0);
  await assert.rejects(client.batches.retrieve(ID), (e) => e instanceof NotFoundError && e.type === "batch_not_found");
});

test("cancelling a finished batch is a ConflictError", async () => {
  const { client } = setup([[409, { error: "the batch is already done", type: "batch_finished" }]]);
  await assert.rejects(client.batches.cancel(ID), (e) => e instanceof ConflictError && e.type === "batch_finished");
});

test("results: one per input line, in order, answers typed as decide's", async () => {
  const { client, calls } = setup([[200, jsonl(ANSWERED, EXPIRED), { "Content-Type": "application/jsonl" }]]);
  const [a, b] = await client.batches.results(ID);
  assert.equal(calls[0].url, `https://example.test/v1/batches/${ID}/results`);
  assert.equal(calls[0].headers.Accept, "application/jsonl");
  assert.equal(a.ok, true);
  assert.equal(a.custom_id, "a");
  assert.equal(a.status, 200);
  assert.ok(a.response.answers.refund instanceof NoulAnswer);
  assert.equal(a.response.answers.refund.decide(), "yes");
  assert.deepEqual(a.usage, { input_tokens: 120, output_tokens: 1, batch: true });
  assert.equal(b.ok, false);
  assert.equal(b.status, null);
  assert.equal(b.error.type, "expired");
  assert.equal(b.response, undefined);
  assert.deepEqual(b.raw, EXPIRED);
});

test("streamResults reads lines split across chunks", async () => {
  const text = jsonl(ANSWERED, EXPIRED, { ...ANSWERED, custom_id: "c" });
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); // splits lines and characters
      controller.close();
    },
  });
  const { client } = setup([[200, body]]);
  const seen = [];
  for await (const r of client.batches.streamResults(ID)) seen.push(r.custom_id);
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("a results file without a final newline still gives its last line", async () => {
  const { client } = setup([[200, JSON.stringify(ANSWERED)]]);
  assert.equal((await client.batches.results(ID)).length, 1);
});

const DELETED = {
  error: "this batch's results were deleted: results are deleted as soon as they have been downloaded once, and at the " +
    "latest 24 hours after the batch finished",
  type: "batch_results_deleted", results_deleted_at: "2026-10-28T09:00:00+00:00",
};

test("results already downloaded are gone (BatchResultsDeletedError) and not retried", async () => {
  const jsonl = [ANSWERED, EXPIRED].map((r) => JSON.stringify(r) + "\n").join("");
  const { client, calls, sleeps } = setup([[200, jsonl], [410, DELETED], [410, DELETED]]);
  assert.equal((await client.batches.results(ID)).length, 2);
  const check = (e) => {
    assert.ok(e instanceof BatchResultsDeletedError);
    assert.ok(e instanceof InvalidRequestError);
    assert.equal(e.status, 410);
    assert.equal(e.type, "batch_results_deleted");
    assert.equal(e.resultsDeletedAt, "2026-10-28T09:00:00+00:00");
    assert.match(e.message, /one download/);
    assert.match(e.message, /24 hours/);
    assert.equal(e.serverMessage, DELETED.error);
    return true;
  };
  await assert.rejects(client.batches.results(ID), check);
  await assert.rejects((async () => { for await (const _ of client.batches.streamResults(ID)) { /* none */ } })(), check);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, []);
});

test("a status says when the results were deleted", async () => {
  const { client } = setup([[200, { ...status("done", { done: 2, failed: 0, pending: 0 }), results_available: false, results_deleted_at: "2026-10-28T09:00:00+00:00" }]]);
  assert.equal((await client.batches.retrieve(ID)).results_deleted_at, "2026-10-28T09:00:00+00:00");
});

test("results before the batch ends is a ConflictError (batch_not_finished)", async () => {
  const { client } = setup([[409, { error: "the batch is running; results are ready once it is done", type: "batch_not_finished" }]]);
  await assert.rejects(client.batches.results(ID), (e) => e instanceof ConflictError && e.type === "batch_not_finished");
});

test("an answer this client cannot read stays in raw, as an unanswered line", async () => {
  const odd = { ...ANSWERED, response: { model: "m", answers: { q: { type: "future" } } } };
  const { client } = setup([[200, jsonl(odd)]]);
  const [r] = await client.batches.results(ID);
  assert.equal(r.ok, false);
  assert.equal(r.error.type, "unreadable_answer");
  assert.deepEqual(r.raw, odd);
});

test("waitFor polls with growing waits until the batch is done", async () => {
  const polled = [];
  const { client, calls, sleeps } = setup([
    [200, status("queued", { done: 0, failed: 0, pending: 2 })],
    [200, status("running", { done: 1, failed: 0, pending: 1 })],
    [200, status("running", { done: 1, failed: 0, pending: 1 })],
    [200, status("done", { done: 2, failed: 0, pending: 0 })],
  ]);
  const done = await client.batches.waitFor(ID, { onPoll: (b) => polled.push(b.status) });
  assert.equal(done.status, "done");
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [5000, 7500, 11250]);
  assert.deepEqual(polled, ["queued", "running", "running", "done"]);
});

test("waitFor stops growing the wait at maxInterval", async () => {
  const script = Array.from({ length: 5 }, () => [200, status("running", { done: 0, failed: 0, pending: 2 })]);
  script.push([200, status("failed", { done: 0, failed: 2, pending: 0 })]);
  const { client, sleeps } = setup(script);
  await client.batches.waitFor(ID, { pollInterval: 1000, maxInterval: 2000 });
  assert.deepEqual(sleeps, [1000, 1500, 2000, 2000, 2000]);
});

const cancelledAt = (counts, lines, at) => ({ ...status("cancelled", counts, lines), finished_at: new Date(at).toISOString() });

test("waitFor on a cancelled batch waits for the lines still in progress", async () => {
  const { client, calls } = setup([
    [200, cancelledAt({ done: 1, failed: 0, pending: 0 }, 3, Date.now())],
    [200, cancelledAt({ done: 2, failed: 1, pending: 0 }, 3, Date.now())],
  ]);
  assert.equal((await client.batches.waitFor(ID)).counts.done, 2);
  assert.equal(calls.length, 2);
});

test("waitFor gives up after its timeout, leaving the batch running", async () => {
  const { client, calls } = setup([[200, status("running", { done: 0, failed: 0, pending: 2 })]]);
  await assert.rejects(client.batches.waitFor(ID, { timeout: 0 }), (e) => e instanceof BatchTimeoutError && e.batch.status === "running");
  assert.equal(calls.length, 1);
});

test("waitFor stops when its signal aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("stopped");
  const { client, calls } = setup([[200, status("running", { done: 0, failed: 0, pending: 2 })]], {
    sleep: () => new Promise(() => {}), // a wait that never ends on its own
  });
  const waiting = client.batches.waitFor(ID, { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(waiting, (e) => e === reason);
  assert.equal(calls.length, 1);
  const again = setup([]);
  await assert.rejects(again.client.batches.waitFor(ID, { signal: AbortSignal.abort(reason) }), (e) => e === reason);
  assert.equal(again.calls.length, 0);
});

test("waitFor refuses intervals that are not numbers of milliseconds", async () => {
  const { client } = setup([]);
  await assert.rejects(client.batches.waitFor(ID, { pollInterval: -1 }), RangeError);
  await assert.rejects(client.batches.waitFor(ID, { timeout: Number.NaN }), RangeError);
});

test("a sparse array is refused, hole by hole", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.batches.create(new Array(1)), (e) => e instanceof ValidationError && /line 1: must be an object/.test(e.message));
  const holey = [line("a"), , line("c")]; // eslint-disable-line no-sparse-arrays
  await assert.rejects(client.batches.create(holey), (e) => e instanceof ValidationError && /line 2: must be an object/.test(e.message));
  assert.equal(calls.length, 0);
});

test("waitFor refuses waits under a second, so it can never poll in a tight loop", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.batches.waitFor(ID, { maxInterval: 0 }), RangeError);
  await assert.rejects(client.batches.waitFor(ID, { pollInterval: 999 }), RangeError);
  assert.equal(calls.length, 0);
});

test("waitFor's signal also ends a status request in flight, and never resolves after it", async () => {
  const controller = new AbortController();
  const reason = new Error("stopped");
  let seenSignal;
  const fetch = (url, init) => new Promise((resolve, reject) => {
    seenSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });
  const client = new Launchables({ apiKey: "launchables_test", baseURL: "https://example.test", fetch, sleep: async () => {} });
  const waiting = client.batches.waitFor(ID, { signal: controller.signal });
  setTimeout(() => controller.abort(reason), 5);
  await assert.rejects(waiting, (e) => e === reason);
  assert.equal(seenSignal.aborted, true);
});

test("waitFor takes a cancelled batch whose counts never add up as finished 10 minutes after the cancel", async () => {
  const { client, calls } = setup([[200, cancelledAt({ done: 1, failed: 0, pending: 0 }, 3, Date.now() - 11 * 60_000)]]);
  assert.equal((await client.batches.waitFor(ID)).status, "cancelled");
  assert.equal(calls.length, 1);
});

test("waitFor keeps waiting through an outage longer than the client's own retries", async () => {
  const down = Array.from({ length: 4 }, () => [502, { error: "bad gateway" }]); // 1 try + 3 retries: one failed poll
  const { client, calls } = setup([...down, new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed"),
    new TypeError("fetch failed"), [200, status("done", { done: 2, failed: 0, pending: 0 })]]);
  assert.equal((await client.batches.waitFor(ID)).status, "done");
  assert.equal(calls.length, 9);
});

test("waitFor does not wait through errors that will not pass", async () => {
  const a = setup([[503, { error: "the batch API is not available on this server", type: "batch_unavailable" }]]);
  await assert.rejects(a.client.batches.waitFor(ID), (e) => e instanceof APIError && e.type === "batch_unavailable");
  const b = setup([[404, { error: "batch not found", type: "batch_not_found" }]]);
  await assert.rejects(b.client.batches.waitFor(ID), NotFoundError);
});

test("waitFor's timeout also ends a status request in flight", async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const client = new Launchables({ apiKey: "launchables_test", baseURL: "https://example.test", fetch, sleep: async () => {} });
  const t0 = Date.now();
  await assert.rejects(client.batches.waitFor(ID, { timeout: 30 }), (e) => e instanceof BatchTimeoutError && e.batch === undefined);
  assert.ok(Date.now() - t0 < 5_000);
});

test("the first wait is capped by maxInterval", async () => {
  const { client, sleeps } = setup([[200, status("running", { done: 0, failed: 0, pending: 2 })], [200, status("done", { done: 2, failed: 0, pending: 0 })]]);
  await client.batches.waitFor(ID, { pollInterval: 60_000, maxInterval: 2_000 });
  assert.deepEqual(sleeps, [2000]);
});

test("waitFor refuses a timeout longer than a timer can wait", async () => {
  const { client, calls } = setup([]);
  await assert.rejects(client.batches.waitFor(ID, { timeout: 2 ** 31 }), RangeError);
  assert.equal(calls.length, 0);
});

test("create sends one Idempotency-Key on every retry, or the caller's own", async () => {
  const { client, calls } = setup([[429, { error: "rate limit", type: "rate_limited" }, { "Retry-After": "1" }], [200, CREATED], [200, CREATED]]);
  await client.batches.create([line("a")]);
  await client.batch([line("a")], { idempotencyKey: "nightly-2026-10-25" });
  const keys = calls.map((c) => c.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1]);
  assert.equal(keys[0].length, 36);
  assert.equal(keys[2], "nightly-2026-10-25");
  await assert.rejects(client.batches.create([line("a")], { idempotencyKey: "" }), ValidationError);
});

test("create waits out a submission still in progress", async () => {
  const { client, sleeps } = setup([
    [409, { error: "still being answered", type: "idempotency_in_progress" }, { "Retry-After": "2" }],
    [200, CREATED], // the first attempt was refused, so this one is stored
  ]);
  assert.equal((await client.batches.create([line("a")], { idempotencyKey: "b-1" })).id, ID);
  assert.deepEqual(sleeps, [2000]);
});

test("a submission already stored names its batch and is not retried", async () => {
  const { client, calls, sleeps } = setup([
    [409, { error: "still being answered", type: "idempotency_in_progress" }, { "Retry-After": "2" }],
    [409, { error: "already used", type: "idempotency_key_already_used", request_id: "req_0123456789abcdef", batch_id: ID }],
  ]);
  await assert.rejects(client.batches.create([line("a")], { idempotencyKey: "b-1" }), (e) => {
    assert.ok(e instanceof IdempotencyKeyAlreadyUsedError);
    assert.equal(e.batchId, ID);
    assert.equal(e.requestId, "req_0123456789abcdef");
    assert.ok(e.message.includes(ID) && e.message.includes("retrieve"));
    return true;
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [2000]);
});
