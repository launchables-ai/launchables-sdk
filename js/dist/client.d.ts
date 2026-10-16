import { type Questions } from "./questions.js";
import { type Assets, type ImageBudget } from "./images.js";
import { type DecisionResponse, type KeyExpiry, type KeyInfo, type Model } from "./types.js";
import { AdminKeys } from "./admin.js";
export declare const DEFAULT_BASE_URL = "https://api.launchables.ai";
export declare const DEFAULT_ADMIN_BASE_URL = "https://console.launchables.ai";
/** Warn once when a key has this many days or fewer left. */
export declare const KEY_EXPIRY_WARNING_DAYS = 14;
export interface DecideOptions {
    /** The model to ask. Defaults to the server's default. */
    model?: string;
    /**
     * Images, by reference: `{ receipt_photo: await imageFromPath("receipt.jpg") }`. Wherever the reference appears as text
     * in the state (any string value), a question's instructions or a criterion's description, the model sees the image
     * there. Option labels are not searched. Every asset must be referenced at least once.
     */
    assets?: Assets;
    /**
     * The most visual tokens one image may use: 70, 140 or 280. The server uses 280 when it is not given. Lower is cheaper
     * and faster but sees less detail.
     */
    imageBudget?: ImageBudget;
}
export interface LaunchablesOptions {
    /** API token (starts with `launchables_`). Defaults to the LAUNCHABLES_API_TOKEN env var. Keep it on a server. */
    apiKey?: string;
    /** Defaults to https://api.launchables.ai. Set it for self-hosted endpoints. */
    baseURL?: string;
    /**
     * Admin key (starts with `launchables_admin_`) for `client.admin.keys`. Defaults to the LAUNCHABLES_ADMIN_KEY env var.
     * It manages your organisation's API keys and cannot call the Decision API. Keep it on a server.
     */
    adminKey?: string;
    /** Where the key management API is. Defaults to https://console.launchables.ai. */
    adminBaseURL?: string;
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
    /**
     * Called once per key and expiry date when a response shows the key has 14 days or fewer left, so you can rotate it on time
     * (for example, alert your team or start a rotation job). Without it, the client writes one console warning instead.
     */
    onKeyExpiry?: (expiry: KeyExpiry) => void | Promise<void>;
}
export declare class Launchables {
    readonly baseURL: string;
    readonly adminBaseURL: string;
    /** The key management API: `admin.keys.list()`, `create()`, `roll()` and `revoke()`. Needs an admin key. */
    readonly admin: {
        keys: AdminKeys;
    };
    readonly timeout: number;
    readonly maxRetries: number;
    private readonly apiKey;
    private readonly adminKey;
    private readonly fetchImpl;
    private readonly sleep;
    private readonly onKeyExpiry;
    private readonly warnedFor;
    /** The key's expiry as last seen in a response (undefined until a response carries it, or if the key never expires). */
    keyExpiry: KeyExpiry | undefined;
    constructor(options?: LaunchablesOptions);
    /**
     * Ask one or more questions about `state` (a string or a JSON object). The third argument is a model name, or options
     * `{ model, assets, imageBudget }`.
     */
    decide<Q extends Questions>(state: string | Record<string, unknown>, questions: Q, modelOrOptions?: string | DecideOptions): Promise<DecisionResponse<Q>>;
    models(): Promise<Model[]>;
    /**
     * Details of the key this client uses: id, name, when it expires and how many days are left, its limits, and whether
     * it is paused (and why). It counts as no request and no tokens.
     */
    key(): Promise<KeyInfo>;
    private requireKey;
    private requireAdminKey;
    /** Reads the key headers every response to a keyed request carries, and warns once when expiry is close. */
    private noteKeyHeaders;
    /** Returns the server's health payload, e.g. `{ status: "ok" }`. */
    health(): Promise<{
        status: string;
    }>;
    private request;
}
