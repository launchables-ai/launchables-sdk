import { APIConnectionError, AuthenticationError, LaunchablesError, ValidationError, errorForStatus, } from "./errors.js";
import { validateQuestions } from "./questions.js";
import { parseResponse } from "./types.js";
import { VERSION } from "./version.js";
export const DEFAULT_BASE_URL = "https://api.launchables.ai";
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
export class Launchables {
    baseURL;
    timeout;
    maxRetries;
    apiKey;
    fetchImpl;
    sleep;
    onKeyExpiry;
    warnedFor; // the key and expiry last warned about: once per key and date
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
        this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.timeout = options.timeout ?? 30_000;
        this.maxRetries = maxRetries;
        this.fetchImpl = options.fetch;
        this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.onKeyExpiry = options.onKeyExpiry;
    }
    /** Ask one or more questions about `state` (a string or a JSON object). */
    async decide(state, questions, model) {
        const key = this.requireKey();
        if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
            throw new ValidationError("state must be a string or a JSON object");
        }
        const body = { state, questions: validateQuestions(questions) };
        if (model !== undefined)
            body.model = model;
        return parseResponse(await this.request("POST", "/v1/decide", body, key));
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
        if (days > KEY_EXPIRY_WARNING_DAYS || this.warnedFor === which)
            return;
        this.warnedFor = which;
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
    async request(method, path, body, key) {
        const headers = {
            Accept: "application/json",
            "User-Agent": `launchables-js/${VERSION}`,
        };
        if (key)
            headers.Authorization = `Bearer ${key}`;
        let payload;
        if (body !== undefined) {
            payload = JSON.stringify(body);
            headers["Content-Type"] = "application/json";
        }
        const doFetch = this.fetchImpl ?? globalThis.fetch;
        for (let attempt = 0;; attempt++) {
            let err;
            let retryAfterMs;
            try {
                const res = await doFetch(this.baseURL + path, {
                    method,
                    headers,
                    body: payload,
                    signal: AbortSignal.timeout(this.timeout),
                });
                const text = await res.text();
                if (key)
                    this.noteKeyHeaders(res.headers);
                if (res.ok)
                    return decode(text, res.status);
                const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
                retryAfterMs = retryAfter === undefined ? undefined : retryAfter * 1000;
                err = httpError(res.status, text, retryAfter);
                if (!RETRY_STATUSES.has(res.status))
                    throw err;
            }
            catch (e) {
                if (e instanceof LaunchablesError) {
                    if (!(e.status !== undefined && RETRY_STATUSES.has(e.status)))
                        throw e;
                    err = e;
                }
                else {
                    const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
                    err = new APIConnectionError(`Could not reach ${this.baseURL}: ${reason}`);
                    err.cause = e;
                }
            }
            if (attempt >= this.maxRetries)
                throw err;
            await this.sleep(Math.min(retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_MS));
        }
    }
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
    }
    catch {
        const t = text.slice(0, 200).trim();
        if (t)
            message = t;
    }
    return errorForStatus(status, message, body, retryAfter);
}
