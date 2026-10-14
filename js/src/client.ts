import {
  APIConnectionError,
  AuthenticationError,
  LaunchablesError,
  ValidationError,
  errorForStatus,
} from "./errors.js";
import { validateQuestions, type Questions } from "./questions.js";
import { parseResponse, type DecisionResponse, type Model } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.launchables.ai";
const RETRY_STATUSES = new Set([429, 502, 503]);
const BACKOFF_BASE_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export interface LaunchablesOptions {
  /** API token (starts with `launchables_`). Defaults to the LAUNCHABLES_API_TOKEN env var. Keep it on a server. */
  apiKey?: string;
  /** Defaults to https://api.launchables.ai. Set it for self-hosted endpoints. */
  baseURL?: string;
  /** Per-attempt timeout in milliseconds. Default 30000. */
  timeout?: number;
  /** Retries after the first attempt for 429, 502, 503 and connection errors. Default 3. */
  maxRetries?: number;
  /** Custom fetch implementation (defaults to the global fetch). Mainly for tests. */
  fetch?: typeof fetch;
  /** Custom sleep, in milliseconds. Mainly for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Allow constructing the client in a browser. Do not do this with a real key. */
  dangerouslyAllowBrowser?: boolean;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const s = Number(value);
  return Number.isFinite(s) && s >= 0 ? s : undefined; // HTTP-date form is not supported
}

export class Launchables {
  readonly baseURL: string;
  readonly timeout: number;
  readonly maxRetries: number;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LaunchablesOptions = {}) {
    const g = globalThis as { window?: unknown; document?: unknown };
    if (g.window !== undefined && g.document !== undefined && !options.dangerouslyAllowBrowser) {
      throw new LaunchablesError(
        "Launchables clients must run on a server: an API key in browser code is public. " +
          "Call it from your backend (or set dangerouslyAllowBrowser: true if you accept the risk).",
      );
    }
    const maxRetries = options.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new RangeError("maxRetries must be an integer >= 0");
    this.apiKey = options.apiKey ?? process.env.LAUNCHABLES_API_TOKEN;
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = maxRetries;
    this.fetchImpl = options.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Ask one or more questions about `state` (a string or a JSON object). */
  async decide<Q extends Questions>(
    state: string | Record<string, unknown>,
    questions: Q,
    model?: string,
  ): Promise<DecisionResponse<Q>> {
    const key = this.apiKey ?? process.env.LAUNCHABLES_API_TOKEN;
    if (!key) {
      throw new AuthenticationError(
        "No API key. Pass { apiKey } or set the LAUNCHABLES_API_TOKEN environment variable.",
      );
    }
    if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
      throw new ValidationError("state must be a string or a JSON object");
    }
    const body: Record<string, unknown> = { state, questions: validateQuestions(questions) };
    if (model !== undefined) body.model = model;
    return parseResponse<Q>(await this.request("POST", "/v1/decide", body, key));
  }

  async models(): Promise<Model[]> {
    const data = await this.request("GET", "/v1/models");
    return (data.data as Model[] | undefined) ?? [];
  }

  /** Returns the server's health payload, e.g. `{ status: "ok" }`. */
  async health(): Promise<{ status: string }> {
    return (await this.request("GET", "/health")) as { status: string };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    key?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `launchables-js/${VERSION}`,
    };
    if (key) headers.Authorization = `Bearer ${key}`;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
    }
    const doFetch = this.fetchImpl ?? globalThis.fetch;

    for (let attempt = 0; ; attempt++) {
      let err: LaunchablesError;
      let retryAfterMs: number | undefined;
      try {
        const res = await doFetch(this.baseURL + path, {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(this.timeout),
        });
        const text = await res.text();
        if (res.ok) return decode(text, res.status);
        const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
        retryAfterMs = retryAfter === undefined ? undefined : retryAfter * 1000;
        err = httpError(res.status, text, retryAfter);
        if (!RETRY_STATUSES.has(res.status)) throw err;
      } catch (e) {
        if (e instanceof LaunchablesError) {
          if (!(e.status !== undefined && RETRY_STATUSES.has(e.status))) throw e;
          err = e;
        } else {
          const reason = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
          err = new APIConnectionError(`Could not reach ${this.baseURL}: ${reason}`);
          (err as { cause?: unknown }).cause = e;
        }
      }
      if (attempt >= this.maxRetries) throw err;
      await this.sleep(Math.min(retryAfterMs ?? BACKOFF_BASE_MS * 2 ** attempt, MAX_RETRY_AFTER_MS));
    }
  }
}

function decode(text: string, status: number): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LaunchablesError("Server returned a non-JSON response", status, text.slice(0, 500));
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new LaunchablesError("Server returned an unexpected response", status, data);
  }
  return data as Record<string, unknown>;
}

function httpError(status: number, text: string, retryAfter?: number): LaunchablesError {
  let message = `HTTP ${status}`;
  let body: unknown = text;
  try {
    body = JSON.parse(text);
    const m = (body as { error?: unknown } | null)?.error;
    if (typeof m === "string") message = m;
  } catch {
    const t = text.slice(0, 200).trim();
    if (t) message = t;
  }
  return errorForStatus(status, message, body, retryAfter);
}
