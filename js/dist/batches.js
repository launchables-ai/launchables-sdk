import { APIConnectionError, APIError, LaunchablesError, RateLimitError, ValidationError } from "./errors.js";
import { idempotencyHeaders } from "./idempotency.js";
import { validateQuestions } from "./questions.js";
import { validateAssets, validateImageBudget } from "./images.js";
import { parseResponse } from "./types.js";
/** A `custom_id`: 1 to 64 letters, digits or `_ . : -`, unique in its batch. */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The statuses after which a batch never changes again. */
export const BATCH_FINISHED_STATUSES = ["done", "failed", "cancelled"];
/** `waitFor` ran out of time. The batch keeps running; `batch` is its last status read (undefined if none was). */
export class BatchTimeoutError extends LaunchablesError {
    batch;
    constructor(message, batch) {
        super(message);
        this.batch = batch;
    }
}
const TIMED_OUT = new Error("waitFor timed out");
const MAX_TIMER_MS = 2 ** 31 - 1; // the longest a timer can wait
/** An error that says nothing about the batch: the endpoint was briefly unreachable, busy or rate-limited. */
function passing(e) {
    if (e instanceof APIConnectionError || e instanceof RateLimitError)
        return true;
    return e instanceof APIError && e.type !== "batch_unavailable";
}
/** How long after a cancel `waitFor` waits for the lines in progress before taking the batch as finished anyway. */
const CANCEL_SETTLE_MS = 10 * 60_000;
const batchPath = (id) => {
    if (typeof id !== "string" || !/^batch_[0-9a-f]{24}$/.test(id)) {
        throw new ValidationError(`not a batch id: ${JSON.stringify(id)} (ids look like "batch_" and 24 hex digits)`);
    }
    return `/v1/batches/${id}`;
};
/** Checks every line before anything is sent and returns the JSONL body. Throws `ValidationError` naming the line. */
export function toJSONL(lines) {
    if (!Array.isArray(lines) || lines.length === 0)
        throw new ValidationError("a batch needs at least one line");
    const seen = new Set();
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]; // a hole in a sparse array is undefined, refused below
        let where = `line ${i + 1}`;
        if (typeof line !== "object" || line === null || Array.isArray(line))
            throw new ValidationError(`${where}: must be an object`);
        const { custom_id, model, state, questions, assets, image_budget } = line;
        if (typeof custom_id !== "string" || !CUSTOM_ID_PATTERN.test(custom_id)) {
            throw new ValidationError(`${where}: custom_id must be 1 to 64 letters, digits or _ . : -`);
        }
        where += ` (custom_id ${custom_id})`;
        if (seen.has(custom_id))
            throw new ValidationError(`${where}: custom_id is used on an earlier line`);
        seen.add(custom_id);
        if (typeof model !== "string" || model === "") {
            throw new ValidationError(`${where}: every line names its model; a batch has no default model`);
        }
        if (typeof state !== "string" && (typeof state !== "object" || state === null || Array.isArray(state))) {
            throw new ValidationError(`${where}: state must be a string or a JSON object`);
        }
        try {
            validateQuestions(questions);
            if (assets !== undefined) {
                for (const [ref, image] of Object.entries(validateAssets(assets))) {
                    if (typeof image.data_base64 !== "string") {
                        throw new ValidationError(`asset "${ref}" must be inline (data_base64): a batch line cannot carry file parts`);
                    }
                }
            }
            if (image_budget !== undefined)
                validateImageBudget(image_budget);
        }
        catch (e) {
            if (e instanceof ValidationError)
                throw new ValidationError(`${where}: ${e.serverMessage}`);
            throw e;
        }
        out.push(JSON.stringify(line));
    }
    return out.join("\n") + "\n";
}
export function parseResult(data) {
    const usage = (data.usage ?? {});
    const base = {
        custom_id: typeof data.custom_id === "string" ? data.custom_id : null,
        model: typeof data.model === "string" ? data.model : null,
        status: typeof data.status === "number" ? data.status : null,
        usage: { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0), batch: true },
        raw: data,
    };
    const response = data.response;
    if (typeof response === "object" && response !== null && !Array.isArray(response)) {
        try {
            return { ...base, ok: true, response: parseResponse(response) };
        }
        catch {
            return { ...base, ok: false, error: { error: "the answer could not be read by this version of the client", type: "unreadable_answer" } };
        }
    }
    if (typeof data.error === "object" && data.error !== null) {
        return { ...base, ok: false, error: data.error };
    }
    return { ...base, ok: false, error: { error: typeof data.error === "string" ? data.error : "this line was not answered" } };
}
/** The Batch API: many decisions in one file, answered within 24 hours at half the live price. */
export class Batches {
    t;
    constructor(t) {
        this.t = t;
    }
    /**
     * Submit a batch. Every line is checked here first (`ValidationError` names the line), then the server checks every
     * line again and refuses the whole batch if any is invalid (`InvalidRequestError` with `type` "invalid_batch" and the
     * lines in `body.errors`), so nothing is queued half-way.
     */
    async create(lines, options = {}) {
        const body = toJSONL(lines);
        if (options.webhookUrl !== undefined && (typeof options.webhookUrl !== "string" || !options.webhookUrl.startsWith("https://"))) {
            throw new ValidationError("webhookUrl must be an https address");
        }
        const headers = {
            ...(await idempotencyHeaders(options.idempotencyKey)),
            ...(options.webhookUrl ? { "Launchables-Webhook-Url": options.webhookUrl } : {}),
        };
        return (await this.t.json("POST", "/v1/batches", { body, contentType: "application/jsonl", headers, create: true }));
    }
    /** Every batch of the calling key, oldest first (until it is deleted). */
    async list() {
        const data = await this.t.json("GET", "/v1/batches");
        return data.data ?? [];
    }
    /** A batch's status and counts. */
    async retrieve(id) {
        return (await this.t.json("GET", batchPath(id)));
    }
    /**
     * Stop a batch. Lines already answered stay in the results and are billed; the rest read as cancelled and are not.
     * Cancelling a cancelled batch is not an error; a batch already done or failed throws `ConflictError` (`type`
     * "batch_finished").
     */
    async cancel(id) {
        return (await this.t.json("POST", `${batchPath(id)}/cancel`));
    }
    /**
     * Every result line, read as it arrives: one per input line, in input order. Use this for large batches, so the whole
     * file is never held in memory. Throws `ConflictError` (`type` "batch_not_finished") until the batch has ended.
     *
     * Results can be downloaded once: they are deleted as soon as they have been sent in full, and results never downloaded
     * are deleted 24 hours after the batch finished. After that this throws `BatchResultsDeletedError` (410), so keep what
     * you read.
     */
    async *streamResults(id) {
        for await (const line of this.t.lines(`${batchPath(id)}/results`)) {
            let data;
            try {
                data = JSON.parse(line);
            }
            catch {
                throw new LaunchablesError("Server returned a results line that is not JSON", 200, line.slice(0, 500));
            }
            if (typeof data !== "object" || data === null || Array.isArray(data)) {
                throw new LaunchablesError("Server returned an unexpected results line", 200, data);
            }
            yield parseResult(data);
        }
    }
    /**
     * Every result line at once, in input order. For large batches prefer `streamResults`. Results can be downloaded once
     * (see `streamResults`); a later call throws `BatchResultsDeletedError`.
     */
    async results(id) {
        const out = [];
        for await (const r of this.streamResults(id))
            out.push(r);
        return out;
    }
    /**
     * Polls the batch until it has ended and its results can be collected, waiting longer between checks each time
     * (`pollInterval`, times 1.5 each check, up to `maxInterval`). Resolves with the final status; it does not cancel the
     * batch when it gives up.
     */
    async waitFor(id, options = {}) {
        const path = batchPath(id);
        const first = options.pollInterval ?? 5_000;
        const most = options.maxInterval ?? 60_000;
        const timeout = options.timeout ?? 25 * 3_600_000;
        for (const [name, v, least] of [["pollInterval", first, 1000], ["maxInterval", most, 1000], ["timeout", timeout, 0]]) {
            if (typeof v !== "number" || !Number.isFinite(v) || v < least)
                throw new RangeError(`${name} must be a number of milliseconds >= ${least}`);
        }
        if (timeout > MAX_TIMER_MS)
            throw new RangeError(`timeout must be at most ${MAX_TIMER_MS} ms (about 24.8 days)`);
        options.signal?.throwIfAborted();
        const started = Date.now();
        // one signal for the caller's abort and the deadline, so both reach a status request in flight and the waits
        const stop = new AbortController();
        const onAbort = () => stop.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => stop.abort(TIMED_OUT), timeout);
        let last;
        const stopped = () => options.signal?.aborted
            ? options.signal.reason
            : new BatchTimeoutError(`batch ${id} is still ${last?.status ?? "unknown"} after ${timeout} ms`, last);
        let interval = Math.min(first, most);
        try {
            for (;;) {
                let batch;
                try {
                    batch = (await this.t.json("GET", path, { signal: stop.signal }));
                }
                catch (e) {
                    if (stop.signal.aborted)
                        throw stopped();
                    if (!passing(e))
                        throw e; // an outage longer than the client's own retries: keep waiting, the batch is unaffected
                }
                if (stop.signal.aborted)
                    throw stopped();
                if (batch) {
                    last = batch;
                    options.onPoll?.(batch);
                    if (finished(batch))
                        return batch;
                }
                const left = timeout - (Date.now() - started);
                if (left <= 0)
                    throw stopped();
                try {
                    await this.t.sleep(Math.min(interval, left), stop.signal);
                }
                catch (e) {
                    if (stop.signal.aborted)
                        throw stopped();
                    throw e;
                }
                interval = Math.min(interval * 1.5, most);
            }
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
        }
    }
}
/**
 * Whether a batch's results can be collected: done or failed, or cancelled with every line accounted for (lines that were
 * in progress when it was cancelled still come back, and are billed, before its results are ready). A cancelled batch
 * whose counts never add up (its lines could not be read back) is taken as finished 10 minutes after the cancel.
 */
export function finished(batch, now = Date.now()) {
    if (batch.status === "done" || batch.status === "failed")
        return true;
    if (batch.status !== "cancelled")
        return false;
    const c = batch.counts ?? { done: 0, failed: 0, pending: 0 };
    if (c.done + c.failed >= batch.lines)
        return true;
    const at = batch.finished_at ? Date.parse(batch.finished_at) : Number.NaN;
    return !Number.isFinite(at) || now - at >= CANCEL_SETTLE_MS;
}
