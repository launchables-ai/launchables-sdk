import { APIConnectionError, AuthenticationError, LaunchablesError, ValidationError, errorForStatus, } from "./errors.js";
import { validateQuestions } from "./questions.js";
import { validateAssets, validateImageBudget } from "./images.js";
import { parseResponse } from "./types.js";
import { VERSION } from "./version.js";
import { AdminKeys } from "./admin.js";
import { Batches } from "./batches.js";
export const DEFAULT_BASE_URL = "https://api.launchables.ai";
export const DEFAULT_ADMIN_BASE_URL = "https://console.launchables.ai";
const RETRY_STATUSES = new Set([429, 502, 503]);
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;
/** Warn once when a key has this many days or fewer left. */
export const KEY_EXPIRY_WARNING_DAYS = 14;
/** Whole days from today (UTC) to a YYYY-MM-DD date, or undefined if it is not one. */
function daysUntil(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
        return undefined;
    const end = Date.parse(`${date}T00:00:00Z`);
    if (Number.isNaN(end))
        return undefined;
    const now = new Date();
    return Math.round((end - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000);
}
function parseRetryAfter(value) {
    if (!value)
        return undefined;
    const s = Number(value);
    return Number.isFinite(s) && s >= 0 ? s : undefined; // HTTP-date form is not supported
}
// Trailing slashes off a base URL, in one pass (a regular expression here can be slowed by a long run of slashes).
function trimSlashes(url) {
    let end = url.length;
    while (end > 0 && url[end - 1] === "/")
        end -= 1;
    return url.slice(0, end);
}
export class Launchables {
    baseURL;
    adminBaseURL;
    /** The key management API: `admin.keys.list()`, `create()`, `roll()` and `revoke()`. Needs an admin key. */
    admin;
    /** The Batch API: `batches.create()`, `list()`, `retrieve()`, `results()`, `streamResults()`, `cancel()` and `waitFor()`. */
    batches;
    timeout;
    maxRetries;
    apiKey;
    adminKey;
    fetchImpl;
    sleep;
    onKeyExpiry;
    warnedFor = new Set(); // every key and expiry date warned about: once per pair
    /** The key's expiry as last seen in a response (undefined until a response carries it, or if the key never expires). */
    keyExpiry;
    constructor(options = {}) {
        const g = globalThis;
        if (g.window !== undefined && g.document !== undefined && !options.dangerouslyAllowBrowser) {
            throw new LaunchablesError("Launchables clients must run on a server: an API key in browser code is public. " +
                "Call it from your backend (or set dangerouslyAllowBrowser: true if you accept the risk).");
        }
        const maxRetries = options.maxRetries ?? 3;
        if (!Number.isInteger(maxRetries) || maxRetries < 0)
            throw new RangeError("maxRetries must be an integer >= 0");
        this.apiKey = options.apiKey ?? process.env.LAUNCHABLES_API_TOKEN;
        this.baseURL = trimSlashes(options.baseURL ?? DEFAULT_BASE_URL);
        this.adminKey = options.adminKey;
        this.adminBaseURL = trimSlashes(options.adminBaseURL ?? DEFAULT_ADMIN_BASE_URL);
        this.admin = {
            keys: new AdminKeys((method, path, body) => this.request(method, path, body, this.requireAdminKey(), { baseURL: this.adminBaseURL, admin: true })),
        };
        this.batches = new Batches({
            json: async (method, path, init = {}) => {
                const key = this.requireKey();
                const send = { ...init };
                // a submission is retried only when the server refused it without storing it, so a retry never makes two batches
                if (init.create)
                    send.once = (status, type) => (status === 429 && type === "rate_limited") || (status === 503 && type === "busy");
                const { res, done } = await this.send(method, path, send, key, { baseURL: this.baseURL, admin: false });
                try {
                    return decode(await res.text(), res.status);
                }
                finally {
                    done();
                }
            },
            lines: (path) => this.streamLines(path, this.requireKey()),
            sleep: (ms, signal) => abortable(this.sleep(ms), signal),
        });
        this.timeout = options.timeout ?? 30_000;
        this.maxRetries = maxRetries;
        this.fetchImpl = options.fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.onKeyExpiry = options.onKeyExpiry;
    }
    /**
     * Ask one or more questions about `state` (a string or a JSON object). The third argument is a model name, or options
     * `{ model, assets, imageBudget }`.
     */
    async decide(state, questions, modelOrOptions) {
        const key = this.requireKey();
        if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
            throw new ValidationError("state must be a string or a JSON object");
        }
        const opts = typeof modelOrOptions === "string" ? { model: modelOrOptions } : (modelOrOptions ?? {});
        if (typeof opts !== "object" || opts === null || Array.isArray(opts))
            throw new ValidationError("the third argument must be a model name or options");
        const body = { state, questions: validateQuestions(questions) };
        if (opts.model !== undefined)
            body.model = opts.model;
        if (opts.assets !== undefined)
            body.assets = validateAssets(opts.assets);
        if (opts.imageBudget !== undefined)
            body.image_budget = validateImageBudget(opts.imageBudget);
        return parseResponse(await this.request("POST", "/v1/decide", body, key));
    }
    /**
     * Submit a batch: many decisions answered within 24 hours at half the live price. The same as `batches.create()`. Each
     * line is a `decide` body with your `custom_id` and its `model`; follow it with `batches.waitFor(id)` and
     * `batches.results(id)`.
     */
    async batch(lines, options) {
        return this.batches.create(lines, options);
    }
    async models() {
        // the key is optional here; when there is one, the response also tells the client when it expires
        const data = await this.request("GET", "/v1/models", undefined, this.apiKey ?? process.env.LAUNCHABLES_API_TOKEN);
        return data.data ?? [];
    }
    /**
     * Details of the key this client uses: id, name, when it expires and how many days are left, its limits, and whether
     * it is paused (and why). It counts as no request and no tokens.
     */
    async key() {
        return (await this.request("GET", "/v1/key", undefined, this.requireKey()));
    }
    requireKey() {
        const key = this.apiKey ?? process.env.LAUNCHABLES_API_TOKEN;
        if (!key) {
            throw new AuthenticationError("No API key. Pass { apiKey } or set the LAUNCHABLES_API_TOKEN environment variable.");
        }
        return key;
    }
    requireAdminKey() {
        const key = this.adminKey ?? process.env.LAUNCHABLES_ADMIN_KEY;
        if (!key) {
            throw new AuthenticationError("No admin key. Pass { adminKey } or set the LAUNCHABLES_ADMIN_KEY environment variable. An owner makes one on the API keys page of the console.");
        }
        return key;
    }
    /** Reads the key headers every response to a keyed request carries, and warns once when expiry is close. */
    noteKeyHeaders(headers) {
        const expires = headers.get("Launchables-Key-Expires");
        if (!expires)
            return;
        const days = daysUntil(expires);
        if (days === undefined)
            return;
        this.keyExpiry = { key_id: headers.get("Launchables-Key-Id"), expires_on: expires, days_left: days };
        const which = `${this.keyExpiry.key_id ?? ""}|${expires}`;
        if (days > KEY_EXPIRY_WARNING_DAYS || this.warnedFor.has(which))
            return;
        this.warnedFor.add(which);
        try {
            if (this.onKeyExpiry) {
                const result = this.onKeyExpiry({ ...this.keyExpiry });
                // an async callback that rejects is swallowed too, so it cannot become an unhandled rejection
                if (result && typeof result.catch === "function")
                    result.catch(() => { });
            }
            else
                console.warn(`Launchables: API key ${this.keyExpiry.key_id ?? ""} expires on ${expires} (${days} day${days === 1 ? "" : "s"} left). Roll it in the console to replace it without downtime.`);
        }
        catch {
            // a failing callback must never break the request it rode on
        }
    }
    /** Returns the server's health payload, e.g. `{ status: "ok" }`. */
    async health() {
        return (await this.request("GET", "/health"));
    }
    async request(method, path, body, key, target = { baseURL: this.baseURL, admin: false }) {
        const init = {};
        if (body !== undefined) {
            init.body = JSON.stringify(body);
            init.contentType = "application/json";
        }
        // a key management POST (create, roll) is retried only when the server refused it unrun (429), so a retry never makes two keys
        if (target.admin && method === "POST")
            init.once = (status) => status === 429;
        const { res, done } = await this.send(method, path, init, key, target);
        try {
            return decode(await res.text(), res.status);
        }
        finally {
            done();
        }
    }
    /**
     * Sends one request, retrying as the options allow, and returns the first 2xx response with its body unread. `done()`
     * stops the timeout; until it is called, `timeout` covers the whole exchange.
     */
    async send(method, path, init, key, target) {
        const headers = {
            Accept: init.accept ?? "application/json",
            "User-Agent": `launchables-js/${VERSION}`,
            ...init.headers,
        };
        if (key)
            headers.Authorization = `Bearer ${key}`;
        if (init.body !== undefined)
            headers["Content-Type"] = init.contentType ?? "application/json";
        const doFetch = this.fetchImpl ?? globalThis.fetch;
        // `once`: a request that must never run twice is retried only on the statuses it names, and never after a lost connection
        const retryable = (status, type) => type !== "batch_unavailable" && (init.once ? init.once(status, type) : RETRY_STATUSES.has(status));
        for (let attempt = 0;; attempt++) {
            let err;
            let retryAfterMs;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), this.timeout);
            const done = () => clearTimeout(timer);
            try {
                const res = await doFetch(target.baseURL + path, {
                    method,
                    headers,
                    body: init.body,
                    signal: controller.signal,
                });
                if (key && !target.admin)
                    this.noteKeyHeaders(res.headers);
                if (res.ok)
                    return { res, done, controller };
                const text = await res.text();
                done();
                const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
                retryAfterMs = retryAfter === undefined ? undefined : retryAfter * 1000;
                err = httpError(res.status, text, retryAfter);
                if (!retryable(res.status, err.type))
                    throw err;
            }
            catch (e) {
                done();
                if (e instanceof LaunchablesError) {
                    if (!(e.status !== undefined && retryable(e.status, e.type)))
                        throw e;
                    err = e;
                }
                else {
                    const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
                    err = new APIConnectionError(`Could not reach ${target.baseURL}: ${reason}`);
                    err.cause = e;
                    if (init.once)
                        throw err;
                }
            }
            if (attempt >= this.maxRetries)
                throw err;
            await this.sleep(Math.min(retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_MS));
        }
    }
    /** The lines of a JSONL response, as they arrive. `timeout` covers the wait for the response and then each read. */
    async *streamLines(path, key) {
        const { res, done, controller } = await this.send("GET", path, { accept: "application/jsonl" }, key, {
            baseURL: this.baseURL,
            admin: false,
        });
        done();
        if (!res.body) {
            yield* splitLines(await res.text());
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        try {
            for (;;) {
                const idle = setTimeout(() => controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), this.timeout);
                let chunk;
                try {
                    chunk = await reader.read();
                }
                catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    const err = new APIConnectionError(`The results stream from ${this.baseURL} broke off: ${reason}`);
                    err.cause = e;
                    throw err;
                }
                finally {
                    clearTimeout(idle);
                }
                if (chunk.done)
                    break;
                buffered += decoder.decode(chunk.value, { stream: true });
                const end = buffered.lastIndexOf("\n");
                if (end === -1)
                    continue;
                yield* splitLines(buffered.slice(0, end));
                buffered = buffered.slice(end + 1);
            }
            buffered += decoder.decode();
            yield* splitLines(buffered);
        }
        finally {
            reader.releaseLock();
            if (!controller.signal.aborted)
                controller.abort(); // stop the download if the caller left the loop early
        }
    }
}
/** `sleep`, ended early (with the signal's reason) when the signal aborts. */
function abortable(sleep, signal) {
    if (!signal)
        return sleep;
    if (signal.aborted)
        return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        sleep.then(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, (e) => {
            signal.removeEventListener("abort", onAbort);
            reject(e);
        });
    });
}
function* splitLines(text) {
    for (const line of text.split("\n"))
        if (line.trim() !== "")
            yield line;
}
function decode(text, status) {
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        throw new LaunchablesError("Server returned a non-JSON response", status, text.slice(0, 500));
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new LaunchablesError("Server returned an unexpected response", status, data);
    }
    return data;
}
function httpError(status, text, retryAfter) {
    let message = `HTTP ${status}`;
    let body = text;
    try {
        body = JSON.parse(text);
        const m = body?.error;
        if (typeof m === "string")
            message = m;
        // the key management API sends {"error": {"type", "message"}}
        else if (typeof m?.message === "string")
            message = m.message;
    }
    catch {
        const t = text.slice(0, 200).trim();
        if (t)
            message = t;
    }
    return errorForStatus(status, message, body, retryAfter);
}
