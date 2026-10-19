import { LaunchablesError, ValidationError } from "./errors.js";
import { validateQuestions } from "./questions.js";
import { validateAssets, validateImageBudget } from "./images.js";
import { parseResponse } from "./types.js";
/** A `custom_id`: 1 to 64 letters, digits or `_ . : -`, unique in its batch. */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
/** The statuses after which a batch never changes again. */
export const BATCH_FINISHED_STATUSES = ["done", "failed", "cancelled"];
/** `waitFor` ran out of time. The batch keeps running; `batch` is its last status. */
export class BatchTimeoutError extends LaunchablesError {
    batch;
    constructor(message, batch) {
        super(message);
        this.batch = batch;
    }
}
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
    const result = {
        custom_id: typeof data.custom_id === "string" ? data.custom_id : null,
        model: typeof data.model === "string" ? data.model : null,
        status: typeof data.status === "number" ? data.status : null,
        ok: false,
        usage: { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0), batch: true },
        raw: data,
    };
    const response = data.response;
    if (typeof response === "object" && response !== null && !Array.isArray(response)) {
        try {
            result.response = parseResponse(response);
            result.ok = true;
        }
        catch {
            result.error = { error: "the answer could not be read by this version of the client", type: "unreadable_answer" };
        }
    }
    else if (typeof data.error === "object" && data.error !== null) {
        result.error = data.error;
    }
    else {
        result.error = { error: typeof data.error === "string" ? data.error : "this line was not answered" };
    }
    return result;
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
        const headers = options.webhookUrl ? { "Launchables-Webhook-Url": options.webhookUrl } : {};
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
     * file is never held in memory. Throws `ConflictError` (`type` "batch_not_finished") until the batch has ended. The first
     * collection starts the retention clock.
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
    /** Every result line at once, in input order. For large batches prefer `streamResults`. */
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
        const started = Date.now();
        let interval = first;
        for (;;) {
            options.signal?.throwIfAborted();
            const batch = (await this.t.json("GET", path, { signal: options.signal }));
            options.signal?.throwIfAborted();
            options.onPoll?.(batch);
            if (finished(batch))
                return batch;
            const left = timeout - (Date.now() - started);
            if (left <= 0)
                throw new BatchTimeoutError(`batch ${id} is still ${batch.status} after ${timeout} ms`, batch);
            await this.t.sleep(Math.min(interval, left), options.signal);
            interval = Math.min(interval * 1.5, most);
        }
    }
}
/**
 * Whether a batch's results can be collected: done or failed, or cancelled with every line accounted for (lines that were
 * in progress when it was cancelled still come back, and are billed, before its results are ready).
 */
export function finished(batch) {
    if (batch.status === "done" || batch.status === "failed")
        return true;
    if (batch.status !== "cancelled")
        return false;
    const c = batch.counts ?? { done: 0, failed: 0, pending: 0 };
    return c.done + c.failed >= batch.lines;
}
