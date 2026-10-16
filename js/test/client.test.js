import test from "node:test";
import assert from "node:assert/strict";
import {
  Launchables, noul, choice, score, NoulAnswer, VERSION,
  LaunchablesError, AuthenticationError, OutOfCreditError, PermissionDeniedError, RateLimitError,
  InvalidRequestError, ValidationError, APIError, APIConnectionError, NotFoundError, ConflictError, DEFAULT_ADMIN_BASE_URL,
  imageFromBytes, imageFromPath, detectImageFormat, MAX_IMAGE_BYTES,
} from "../dist/index.js";

const NOUL = { type: "noul", noul: 0.04 };
const CHOICE = { type: "choice", choice: "returns", probabilities: { billing: 0.06, returns: 0.89, other: 0.05 } };
const SCORE = { type: "score", score: 1.92, level: 2, probabilities: { 0: 0.03, 1: 0.12, 2: 0.75, 3: 0.1 } };

/** Mock fetch replaying a script of [status, body, headers] or Errors. */
function setup(script, opts = {}) {
  const calls = [];
  const sleeps = [];
  const fetch = async (url, init) => {
    calls.push({ url, ...init, json: init.body ? JSON.parse(init.body) : undefined });
    const next = script.shift() ?? [200, {}];
    if (next instanceof Error) throw next;
    const [status, body, headers] = next;
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  };
  const client = new Launchables({
    apiKey: "launchables_test", baseURL: "https://example.test", fetch,
    sleep: async (ms) => { sleeps.push(ms); }, ...opts,
  });
  return { client, calls, sleeps };
}
const ask = (c) => c.decide("state", { q: noul("Is it?") });

test("noul", async () => {
  const { client, calls } = setup([[200, { model: "myles-g-12b", answers: { refund: NOUL }, usage: { input_tokens: 10, output_tokens: 2 } }]]);
  const r = await client.decide("Bought 12 days ago", { refund: noul("Refund permitted?") });
  assert.equal(r.answers.refund.probability, 0.04);
  assert.equal(r.answers.refund.noul, 0.04);
  assert.equal(r.model, "myles-g-12b");
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 2 });
  assert.deepEqual(r.raw.answers.refund, NOUL);
  const c = calls[0];
  assert.equal(c.url, "https://example.test/v1/decide");
  assert.equal(c.method, "POST");
  assert.equal(c.headers.Authorization, "Bearer launchables_test");
  assert.equal(c.headers["User-Agent"], `launchables-js/${VERSION}`);
  assert.deepEqual(c.json, { state: "Bought 12 days ago", questions: { refund: { type: "noul", instructions: "Refund permitted?" } } });
});

test("choice with object state and model", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: { topic: CHOICE } }]]);
  const r = await client.decide({ ticket: "x" }, { topic: choice("Topic?", ["billing", "returns", "other"]) }, "m");
  assert.equal(r.answers.topic.choice, "returns");
  assert.equal(r.answers.topic.probabilities.returns, 0.89);
  assert.deepEqual(calls[0].json.state, { ticket: "x" });
  assert.equal(calls[0].json.model, "m");
});

test("score", async () => {
  const { client } = setup([[200, { model: "m", answers: { u: SCORE } }]]);
  const r = await client.decide("s", { u: score("Urgency?", ["none", "low", "mid", "high"]) });
  assert.equal(r.answers.u.level, 2);
  assert.equal(r.answers.u.score, 1.92);
  assert.equal(r.answers.u.probabilities["2"], 0.75);
});

test("models and health send no auth, trailing slash trimmed", async () => {
  const { client, calls } = setup([
    [200, { object: "list", data: [{ id: "myles-g-12b", object: "model", owned_by: "launchables" }] }],
    [200, { status: "ok" }],
  ], { baseURL: "https://example.test/", apiKey: undefined });
  assert.equal((await client.models())[0].id, "myles-g-12b");
  assert.deepEqual(await client.health(), { status: "ok" });
  assert.deepEqual(calls.map((c) => c.url), ["https://example.test/v1/models", "https://example.test/health"]);
  for (const c of calls) assert.equal(c.headers.Authorization, undefined);
});

test("missing key", async () => {
  const saved = process.env.LAUNCHABLES_API_TOKEN;
  delete process.env.LAUNCHABLES_API_TOKEN;
  try {
    const { client, calls } = setup([], { apiKey: undefined });
    await assert.rejects(ask(client), (e) => e instanceof AuthenticationError && /LAUNCHABLES_API_TOKEN/.test(e.message));
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.LAUNCHABLES_API_TOKEN = saved;
  }
});

test("env var token, explicit key wins", async () => {
  const saved = process.env.LAUNCHABLES_API_TOKEN;
  process.env.LAUNCHABLES_API_TOKEN = "launchables_env";
  try {
    const a = setup([[200, { model: "m", answers: { q: NOUL } }]], { apiKey: undefined });
    await ask(a.client);
    assert.equal(a.calls[0].headers.Authorization, "Bearer launchables_env");
    const b = setup([[200, { model: "m", answers: { q: NOUL } }]]);
    await ask(b.client);
    assert.equal(b.calls[0].headers.Authorization, "Bearer launchables_test");
  } finally {
    if (saved === undefined) delete process.env.LAUNCHABLES_API_TOKEN;
    else process.env.LAUNCHABLES_API_TOKEN = saved;
  }
});

const cases = [
  [401, AuthenticationError, false], [402, OutOfCreditError, false], [403, PermissionDeniedError, false], [400, InvalidRequestError, false], [404, InvalidRequestError, false],
  [411, InvalidRequestError, false], [413, InvalidRequestError, false], [422, InvalidRequestError, false],
  [429, RateLimitError, true], [502, APIError, true], [503, APIError, true], [500, APIError, false],
];
for (const [status, cls, retried] of cases) {
  test(`HTTP ${status} -> ${cls.name}`, async () => {
    const { client, calls } = setup(Array.from({ length: 5 }, () => [status, { error: `boom ${status}` }]));
    await assert.rejects(ask(client), (e) => {
      assert.ok(e instanceof cls);
      assert.ok(e instanceof LaunchablesError);
      assert.equal(e.status, status);
      assert.equal(e.serverMessage, `boom ${status}`);
      assert.match(e.message, new RegExp(`boom ${status}`));
      assert.equal(e.type, null);
      return true;
    });
    assert.equal(calls.length, retried ? 4 : 1);
  });
}

for (const [status, cls, type] of [
  [402, OutOfCreditError, "out_of_credit"], [402, OutOfCreditError, "budget_exceeded"],
  [403, PermissionDeniedError, "model_not_allowed"],
]) {
  test(`HTTP ${status} ${type} -> ${cls.name}, not retried`, async () => {
    const { client, calls, sleeps } = setup(Array.from({ length: 5 }, () => [status, { error: `no: ${type}`, type }]));
    await assert.rejects(ask(client), (e) => {
      assert.ok(e instanceof cls);
      assert.ok(e instanceof LaunchablesError);
      assert.equal(e.status, status);
      assert.equal(e.type, type);
      assert.equal(e.serverMessage, `no: ${type}`);
      assert.deepEqual(e.body, { error: `no: ${type}`, type });
      return true;
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });
}

test("type exposed on other errors when sent", async () => {
  const a = setup([[401, { error: "bad key", type: "invalid_api_key" }]]);
  await assert.rejects(ask(a.client), (e) => e instanceof AuthenticationError && e.type === "invalid_api_key");
  const b = setup([[429, { error: "slow", type: "rate_limited" }]], { maxRetries: 0 });
  await assert.rejects(ask(b.client), (e) => e instanceof RateLimitError && e.type === "rate_limited");
  const c = setup([[422, "plain failure"]]);
  await assert.rejects(ask(c.client), (e) => e instanceof InvalidRequestError && e.type === null);
  const d = setup([[400, { error: "bad", type: 7 }]]);
  await assert.rejects(ask(d.client), (e) => e instanceof InvalidRequestError && e.type === null);
  assert.equal(new LaunchablesError("local").type, null);
});

test("non-JSON error body", async () => {
  const { client } = setup([[422, "plain failure"]]);
  await assert.rejects(ask(client), (e) => e instanceof InvalidRequestError && e.serverMessage === "plain failure");
});

test("backoff 0.5s, 1s, 2s then success", async () => {
  const { client, calls, sleeps } = setup([
    [429, { error: "slow" }], [502, { error: "x" }], [503, { error: "y" }],
    [200, { model: "m", answers: { q: NOUL } }],
  ]);
  assert.equal((await ask(client)).answers.q.noul, 0.04);
  assert.deepEqual(sleeps, [500, 1000, 2000]);
  assert.equal(calls.length, 4);
});

test("Retry-After honoured and exposed", async () => {
  const a = setup([[429, { error: "slow" }, { "Retry-After": "7" }], [200, { model: "m", answers: { q: NOUL } }]]);
  await ask(a.client);
  assert.deepEqual(a.sleeps, [7000]);
  const b = setup([[429, { error: "daily" }, { "Retry-After": "30" }]], { maxRetries: 0 });
  await assert.rejects(ask(b.client), (e) => e instanceof RateLimitError && e.retryAfter === 30);
  assert.deepEqual(b.sleeps, []);
});

test("connection errors retried then thrown as APIConnectionError", async () => {
  const { client, sleeps } = setup([new TypeError("fetch failed"), new TypeError("fetch failed"), new TypeError("fetch failed")], { maxRetries: 2 });
  await assert.rejects(ask(client), (e) => e instanceof APIConnectionError);
  assert.deepEqual(sleeps, [500, 1000]);
});

test("connection error then success", async () => {
  const { client } = setup([new TypeError("fetch failed"), [200, { model: "m", answers: { q: NOUL } }]]);
  assert.equal((await ask(client)).model, "m");
});

test("400 is never retried", async () => {
  const { client, sleeps } = setup([[400, { error: "bad" }]]);
  await assert.rejects(ask(client), InvalidRequestError);
  assert.deepEqual(sleeps, []);
});

test("validation helpers", () => {
  assert.deepEqual(noul("x", { true: "a", false: "b" }).criteria, { true: "a", false: "b" });
  assert.equal("criteria" in noul("x"), false);
  assert.deepEqual(choice("x", { a: "A" }).criteria, { a: "A" });
  choice("x", Array.from({ length: 26 }, (_, i) => String(i)));
  assert.throws(() => choice("x", Array.from({ length: 27 }, (_, i) => String(i))), /at most 26/);
  assert.throws(() => choice("x", []), ValidationError);
  assert.throws(() => choice("x", ["a", "a"]), /unique/);
  assert.throws(() => score("x", ["one"]), ValidationError);
  assert.throws(() => noul("  "), ValidationError);
  assert.ok(new ValidationError("x") instanceof InvalidRequestError);
});

test("request-level validation sends nothing", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: {} }]]);
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`q${i}`, noul("x")]));
  await assert.rejects(client.decide("s", many), /at most 16/);
  for (const bad of [{}, [], { q: "text" }, { q: { type: "bogus", instructions: "x" } },
    { q: { type: "choice", instructions: "x" } }, { q: { type: "score", instructions: "x" } }, { q: { type: "noul" } }]) {
    await assert.rejects(client.decide("s", bad), ValidationError);
  }
  await assert.rejects(client.decide(123, { q: noul("x") }), ValidationError);
  assert.equal(calls.length, 0);
  await client.decide("s", Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`q${i}`, noul("x")])));
  assert.equal(calls.length, 1);
});

test("NoulAnswer.decide thresholds", () => {
  assert.equal(new NoulAnswer(0.95).decide(), "yes");
  assert.equal(new NoulAnswer(0.04).decide(), "no");
  assert.equal(new NoulAnswer(0.5).decide(), "person");
  assert.equal(new NoulAnswer(0.6).decide({ thresholdYes: 0.6, thresholdNo: 0.4 }), "yes");
  assert.throws(() => new NoulAnswer(0.5).decide({ thresholdYes: 0.2, thresholdNo: 0.8 }), RangeError);
});

// Key expiry (0.2.0): the Launchables-Key-* headers, the warning once at 14 days or fewer, and client.key()
const inDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const OK = { model: "m", answers: { q: NOUL } };

test("expiry header is read and the callback fires once at 14 days or fewer", async () => {
  const seen = [];
  const { client } = setup([
    [200, OK, { "Launchables-Key-Id": "c_1", "Launchables-Key-Expires": inDays(10) }],
    [200, OK, { "Launchables-Key-Id": "c_1", "Launchables-Key-Expires": inDays(10) }],
  ], { onKeyExpiry: (e) => seen.push(e) });
  await ask(client); await ask(client);
  assert.deepEqual(client.keyExpiry, { key_id: "c_1", expires_on: inDays(10), days_left: 10 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { key_id: "c_1", expires_on: inDays(10), days_left: 10 });
});

test("no callback when more than 14 days are left; no header means nothing recorded", async () => {
  const seen = [];
  const { client } = setup([[200, OK, { "Launchables-Key-Expires": inDays(40) }], [200, OK]], { onKeyExpiry: (e) => seen.push(e) });
  await ask(client);
  assert.equal(client.keyExpiry.days_left, 40);
  assert.equal(seen.length, 0);
  const { client: other } = setup([[200, OK]]);
  await ask(other);
  assert.equal(other.keyExpiry, undefined);
});

test("without a callback the client warns once on the console", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const { client } = setup([[200, OK, { "Launchables-Key-Expires": inDays(3) }], [200, OK, { "Launchables-Key-Expires": inDays(3) }]]);
    await ask(client); await ask(client);
  } finally { console.warn = original; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /expires on .* \(3 days left\)/);
});

test("a failing callback never breaks the request; error responses carry the header too", async () => {
  const { client } = setup([[402, { error: "out of credit", type: "out_of_credit" }, { "Launchables-Key-Expires": inDays(2) }]],
    { onKeyExpiry: () => { throw new Error("boom"); } });
  await assert.rejects(ask(client), OutOfCreditError);
  assert.equal(client.keyExpiry.days_left, 2);
});

test("key() returns the calling key's details", async () => {
  const info = { id: "c_1", name: "prod", expires_on: inDays(30), days_left: 30, workspace: null, rate_limit_per_minute: 60, daily_limit: 2000, paused: false };
  const { client, calls } = setup([[200, info, { "Launchables-Key-Expires": inDays(30) }]]);
  assert.deepEqual(await client.key(), info);
  assert.equal(calls[0].url, "https://example.test/v1/key");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, "Bearer launchables_test");
});

test("key() needs an API key", async () => {
  const saved = process.env.LAUNCHABLES_API_TOKEN;
  delete process.env.LAUNCHABLES_API_TOKEN;
  try {
    const client = new Launchables({ baseURL: "https://example.test", fetch: async () => new Response("{}") });
    await assert.rejects(client.key(), AuthenticationError);
  } finally { if (saved !== undefined) process.env.LAUNCHABLES_API_TOKEN = saved; }
});

test("an async callback that rejects is swallowed, not an unhandled rejection", async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const { client } = setup([[200, OK, { "Launchables-Key-Expires": inDays(1) }]], { onKeyExpiry: async () => { throw new Error("boom"); } });
    await ask(client);
    await new Promise((r) => setTimeout(r, 20));
  } finally { process.off("unhandledRejection", onUnhandled); }
  assert.equal(unhandled, 0);
});

test("a new key (or a new expiry date) on the same client warns again", async () => {
  const seen = [];
  const { client } = setup([
    [200, OK, { "Launchables-Key-Id": "c_1", "Launchables-Key-Expires": inDays(5) }],
    [200, OK, { "Launchables-Key-Id": "c_2", "Launchables-Key-Expires": inDays(9) }],
    [200, OK, { "Launchables-Key-Id": "c_2", "Launchables-Key-Expires": inDays(9) }],
    [200, OK, { "Launchables-Key-Id": "c_1", "Launchables-Key-Expires": inDays(5) }],
  ], { onKeyExpiry: (e) => seen.push(e.key_id) });
  await ask(client); await ask(client); await ask(client); await ask(client);
  assert.deepEqual(seen, ["c_1", "c_2"]);
});

// -- key management API (admin keys) ---------------------------------------------------------------------------

const ADMIN = "launchables_admin_test";
const adminSetup = (script, opts = {}) => setup(script, { adminKey: ADMIN, adminBaseURL: "https://console.test", ...opts });
const KEY = { id: "c_1a2b3c4d", name: "ci", prefix: "launchables_AbCd1234", workspace: { id: "w1", name: "Default" },
  created_at: "2026-10-15T12:00:00Z", expires_on: "2027-01-13", last_used_on: null, status: "active", revoked_at: null };

test("admin: list sends the admin key to the console", async () => {
  const { client, calls } = adminSetup([[200, { data: [KEY], has_more: false, next_before: null }]]);
  const page = await client.admin.keys.list();
  assert.deepEqual(page.data, [KEY]);
  assert.equal(calls[0].url, "https://console.test/api/v1/admin/keys");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, `Bearer ${ADMIN}`);
});

test("admin: the console is the default", () => {
  const client = new Launchables({ adminKey: ADMIN });
  assert.equal(client.adminBaseURL, "https://console.launchables.ai");
  assert.equal(DEFAULT_ADMIN_BASE_URL, "https://console.launchables.ai");
});

test("admin: list pages with limit and before; listAll follows them", async () => {
  const { client, calls } = adminSetup([
    [200, { data: [KEY], has_more: true, next_before: "abc+/=" }],
    [200, { data: [{ ...KEY, id: "c_00000002" }], has_more: false, next_before: null }],
  ]);
  const ids = [];
  for await (const k of client.admin.keys.listAll({ limit: 1 })) ids.push(k.id);
  assert.deepEqual(ids, ["c_1a2b3c4d", "c_00000002"]);
  assert.equal(calls[0].url, "https://console.test/api/v1/admin/keys?limit=1");
  assert.equal(calls[1].url, "https://console.test/api/v1/admin/keys?limit=1&before=abc%2B%2F%3D");
});

test("admin: create, roll and revoke", async () => {
  const made = { id: "c_1a2b3c4d", name: "ci", key: "launchables_secret", prefix: "launchables_secretAb", workspace: { id: "w1", name: "Default" }, expires_on: "2026-11-14" };
  const rolled = { ...made, id: "c_99999999", replaces: { id: "c_1a2b3c4d", expires_on: "2026-10-16" } };
  const { client, calls } = adminSetup([[201, made], [201, rolled], [200, { id: "c_99999999", status: "revoked", revoked_at: "2026-10-15T12:00:00Z" }]]);
  assert.deepEqual(await client.admin.keys.create({ name: "ci", expires_in_days: 30 }), made);
  assert.deepEqual(calls[0].json, { name: "ci", expires_in_days: 30 });
  assert.equal(calls[0].method, "POST");
  const r = await client.admin.keys.roll("c_1a2b3c4d");
  assert.equal(r.replaces.expires_on, "2026-10-16");
  assert.equal(calls[1].url, "https://console.test/api/v1/admin/keys/c_1a2b3c4d/roll");
  assert.equal((await client.admin.keys.revoke("c_99999999")).status, "revoked");
  assert.equal(calls[2].method, "DELETE");
  assert.equal(calls[2].url, "https://console.test/api/v1/admin/keys/c_99999999");
});

test("admin: ids are escaped in the path", async () => {
  const { client, calls } = adminSetup([[404, { error: { type: "not_found_error", message: "No key" } }]]);
  await assert.rejects(client.admin.keys.revoke("../x"), NotFoundError);
  assert.equal(calls[0].url, "https://console.test/api/v1/admin/keys/..%2Fx");
});

test("admin: errors carry the server's type and message", async () => {
  const { client } = adminSetup([[409, { error: { type: "conflict_error", message: "This organisation has 5 active keys" } }]]);
  const e = await client.admin.keys.create({ name: "x" }).catch((e) => e);
  assert.ok(e instanceof ConflictError);
  assert.ok(e instanceof InvalidRequestError);
  assert.equal(e.type, "conflict_error");
  assert.equal(e.serverMessage, "This organisation has 5 active keys");
  assert.equal(e.status, 409);
});

test("admin: no admin key", async () => {
  const saved = process.env.LAUNCHABLES_ADMIN_KEY;
  delete process.env.LAUNCHABLES_ADMIN_KEY;
  try {
    const { client, calls } = setup([]);
    await assert.rejects(client.admin.keys.list(), AuthenticationError);
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.LAUNCHABLES_ADMIN_KEY = saved;
  }
});

test("admin: LAUNCHABLES_ADMIN_KEY is read, and the API key is never sent to the console", async () => {
  process.env.LAUNCHABLES_ADMIN_KEY = "launchables_admin_env";
  try {
    const { client, calls } = setup([[200, { data: [], has_more: false, next_before: null }]], { adminBaseURL: "https://console.test" });
    await client.admin.keys.list();
    assert.equal(calls[0].headers.Authorization, "Bearer launchables_admin_env");
  } finally {
    delete process.env.LAUNCHABLES_ADMIN_KEY;
  }
});

test("admin: create needs a name, roll and revoke need an id, before any request", async () => {
  const { client, calls } = adminSetup([]);
  await assert.rejects(client.admin.keys.create({ name: " " }), ValidationError);
  await assert.rejects(client.admin.keys.roll(""), ValidationError);
  assert.equal(calls.length, 0);
});

test("admin: create and roll are not retried after a 503 or a lost connection, so no second key is made", async () => {
  const { client, calls } = adminSetup([[503, { error: { type: "api_error", message: "try again" } }], new TypeError("fetch failed")]);
  await assert.rejects(client.admin.keys.create({ name: "x" }), APIError);
  await assert.rejects(client.admin.keys.roll("c_1a2b3c4d"), APIConnectionError);
  assert.equal(calls.length, 2);
});

test("admin: a 429 is retried (the call did not run); list and revoke retry like any call", async () => {
  const { client, calls, sleeps } = adminSetup([
    [429, { error: { type: "rate_limit_error", message: "slow down" } }], [201, { id: "c_1" }],
    [503, "x"], [200, { data: [], has_more: false, next_before: null }],
  ]);
  assert.equal((await client.admin.keys.create({ name: "x" })).id, "c_1");
  await client.admin.keys.list();
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [500, 500]);
});

test("admin: console responses never set the API key's expiry", async () => {
  const { client } = adminSetup([[200, { data: [], has_more: false, next_before: null }, { "Launchables-Key-Expires": "2026-10-16" }]]);
  await client.admin.keys.list();
  assert.equal(client.keyExpiry, undefined);
});

// 0.4.0: assets, imageBudget and the image helpers
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0, 0]);
const b64 = (u8) => Buffer.from(u8).toString("base64");

test("images: assets and imageBudget are sent", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: { q: NOUL }, usage: { input_tokens: 300, output_tokens: 1 } }]]);
  const r = await client.decide(
    { receipt: "receipt_photo" }, { q: noul("Does the total on receipt_photo equal 23.40?") },
    { model: "m", assets: { receipt_photo: imageFromBytes(JPEG) }, imageBudget: 140 },
  );
  assert.equal(r.usage.input_tokens, 300);
  assert.deepEqual(calls[0].json, {
    state: { receipt: "receipt_photo" },
    questions: { q: { type: "noul", instructions: "Does the total on receipt_photo equal 23.40?" } },
    model: "m",
    assets: { receipt_photo: { type: "image", format: "jpeg", data_base64: b64(JPEG) } },
    image_budget: 140,
  });
});

test("images: a model string still works and nothing extra is sent", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: { q: NOUL } }], [200, { model: "m", answers: { q: NOUL } }]]);
  await client.decide("s", { q: noul("x") }, "m");
  await client.decide("s", { q: noul("x") }, {});
  assert.deepEqual(Object.keys(calls[0].json).sort(), ["model", "questions", "state"]);
  assert.deepEqual(Object.keys(calls[1].json).sort(), ["questions", "state"]);
});

test("images: a plain object is sent as is", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: { q: NOUL } }]]);
  const asset = { format: "png", data_base64: "AAAA" };
  await client.decide("see img", { q: noul("img ok?") }, { assets: { img: asset } });
  assert.deepEqual(calls[0].json.assets, { img: asset });
  assert.equal("image_budget" in calls[0].json, false);
});

test("images: imageBudget must be 70, 140 or 280", async () => {
  const { client, calls } = setup([[200, { model: "m", answers: { q: NOUL } }], [200, { model: "m", answers: { q: NOUL } }], [200, { model: "m", answers: { q: NOUL } }]]);
  for (const bad of [0, 100, 281, "280", null, true]) {
    await assert.rejects(client.decide("s", { q: noul("x") }, { imageBudget: bad }), (e) => e instanceof ValidationError && /70, 140, 280/.test(e.message));
  }
  assert.equal(calls.length, 0);
  for (const good of [70, 140, 280]) await client.decide("s", { q: noul("x") }, { imageBudget: good });
  assert.deepEqual(calls.map((c) => c.json.image_budget), [70, 140, 280]);
});

test("images: bad assets are refused before sending", async () => {
  const { client, calls } = setup([]);
  for (const bad of [[["img", "AAAA"]], { "": imageFromBytes(PNG) }, { img: PNG }, { img: "AAAA" }, { img: null }, "img"]) {
    await assert.rejects(client.decide("img", { q: noul("x") }, { assets: bad }), ValidationError);
  }
  assert.equal(calls.length, 0);
});

test("images: format detected from the bytes", () => {
  assert.deepEqual(imageFromBytes(PNG), { type: "image", format: "png", data_base64: b64(PNG) });
  assert.equal(imageFromBytes(Buffer.from(JPEG)).format, "jpeg");
  assert.equal(imageFromBytes(JPEG.buffer.slice(0)).format, "jpeg");
  assert.equal(imageFromBytes(JPEG, "jpg").format, "jpg");
  assert.equal(imageFromBytes(PNG, "PNG").format, "png");
  // a view into a larger buffer encodes only its own bytes
  const big = new Uint8Array(4 + PNG.length); big.set(PNG, 4);
  assert.equal(imageFromBytes(big.subarray(4)).data_base64, b64(PNG));
  assert.equal(detectImageFormat(new TextEncoder().encode("GIF89a")), undefined);
});

test("images: unknown or mismatched formats are refused", () => {
  const gif = new TextEncoder().encode("GIF89a\0\0\0\0");
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBP");
  for (const [data, fmt] of [[gif], [webp], [new Uint8Array(0)], [PNG, "gif"], [PNG, "jpeg"], [JPEG, "png"], [gif, "png"]]) {
    assert.throws(() => imageFromBytes(data, fmt), ValidationError);
  }
  assert.throws(() => imageFromBytes("not bytes"), ValidationError);
});

test("images: over 16 MiB is refused", () => {
  const ok = new Uint8Array(MAX_IMAGE_BYTES); ok.set(PNG);
  assert.equal(imageFromBytes(ok).format, "png");
  const over = new Uint8Array(MAX_IMAGE_BYTES + 1); over.set(PNG);
  assert.throws(() => imageFromBytes(over), (e) => e instanceof ValidationError && /16 MiB/.test(e.message));
});

test("images: imageFromPath reads the file and detects from the bytes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "launchables-"));
  try {
    const p = join(dir, "photo.bin"); // the name does not decide the format
    await writeFile(p, PNG);
    assert.deepEqual(await imageFromPath(p), { type: "image", format: "png", data_base64: b64(PNG) });
    await assert.rejects(imageFromPath(p, "jpeg"), ValidationError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [status, type] of [[400, "unsupported_image_format"], [400, "image_dimensions"], [400, "unreferenced_asset"], [422, "invalid_image_budget"]]) {
  test(`images: HTTP ${status} ${type} -> InvalidRequestError with type`, async () => {
    const { client, calls } = setup([[status, { error: `asset 'img': ${type}`, type }]]);
    await assert.rejects(client.decide("img", { q: noul("x") }, { assets: { img: imageFromBytes(PNG) } }), (e) => {
      assert.ok(e instanceof InvalidRequestError);
      assert.equal(e.status, status);
      assert.equal(e.type, type);
      assert.match(e.serverMessage, /asset 'img'/);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}
