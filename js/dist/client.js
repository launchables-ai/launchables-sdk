import { APIConnectionError, AuthenticationError, LaunchablesError, ValidationError, errorForStatus, } from "./errors.js";
import { validateQuestions } from "./questions.js";
import { parseResponse } from "./types.js";
import { VERSION } from "./version.js";
export const DEFAULT_BASE_URL = "https://api.launchables.ai";
const RETRY_STATUSES = new Set([429, 502, 503]);
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;
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
    }
    /** Ask one or more questions about `state` (a string or a JSON object). */
    async decide(state, questions, model) {
        const key = this.apiKey ?? process.env.LAUNCHABLES_API_TOKEN;
        if (!key) {
            throw new AuthenticationError("No API key. Pass { apiKey } or set the LAUNCHABLES_API_TOKEN environment variable.");
        }
        if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
            throw new ValidationError("state must be a string or a JSON object");
        }
        const body = { state, questions: validateQuestions(questions) };
        if (model !== undefined)
            body.model = model;
        return parseResponse(await this.request("POST", "/v1/decide", body, key));
    }
    async models() {
        const data = await this.request("GET", "/v1/models");
        return data.data ?? [];
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
