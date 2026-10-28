import { LaunchablesError } from "./errors.js";
import { type Questions } from "./questions.js";
import { type Assets, type ImageBudget } from "./images.js";
import { type DecisionResponse } from "./types.js";
/** A `custom_id`: 1 to 64 letters, digits or `_ . : -`, unique in its batch. */
export declare const CUSTOM_ID_PATTERN: RegExp;
/** The statuses after which a batch never changes again. */
export declare const BATCH_FINISHED_STATUSES: readonly ["done", "failed", "cancelled"];
export type BatchStatus = "queued" | "running" | "done" | "failed" | "cancelled";
/**
 * One line of a batch: the body of one `POST /v1/decide` request, plus your own `custom_id`. Every line names its model;
 * a batch has no default model. Field names are as they are sent (`custom_id`, `image_budget`).
 */
export interface BatchLine<Q extends Questions = Questions> {
    /** Your id for the line, 1 to 64 letters, digits or `_ . : -`, unique in the batch. Results carry it back. */
    custom_id: string;
    /** A model id from `models()`, for example "myles-g-12b". Required on every line. */
    model: string;
    state: string | Record<string, unknown>;
    questions: Q;
    /** Images, inline only (`imageFromBytes` or `imageFromPath`): a batch line cannot carry file parts. */
    assets?: Assets;
    image_budget?: ImageBudget;
}
/** The server's cost estimate for a batch. It is advisory: the bill uses the input tokens actually read, line by line. */
export interface BatchCostEstimate {
    amount: number;
    currency: string;
    input_tokens: number;
    /** The share of the live per-token price a batch pays (0.5). */
    rate: number;
    basis: "estimate";
}
/** What `create` returns: the new batch, queued. */
export interface CreatedBatch {
    id: string;
    object: "batch";
    status: "queued";
    lines: number;
    estimated_cost: BatchCostEstimate;
    /** When the 24-hour window ends: lines not answered by then fail as "expired". */
    expires_at: string;
    /** Where the batch's files are stored. */
    data_region: string;
}
/** A batch's status, from `retrieve`, `list`, `cancel` and `waitFor`. */
export interface Batch {
    id: string;
    object: "batch";
    status: BatchStatus;
    lines: number;
    /** Lines answered, lines failed (cancelled and expired lines count as failed once the batch ends) and lines still to run. */
    counts: {
        done: number;
        failed: number;
        pending: number;
    };
    /** The models the batch's lines name. */
    models: string[];
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    expires_at: string;
    /** Why the batch ended early, e.g. "cancelled", "expired" or "key_revoked"; null otherwise. */
    reason: string | null;
    results_available: boolean;
    /** Whether a webhook address was given (the address itself is never shown). */
    webhook: boolean;
    estimated_cost: BatchCostEstimate;
    data_region: string;
    /** When the batch and its results are deleted at the latest; null while it runs. */
    delete_after: string | null;
    /** When the results were deleted (downloaded once, or 24 hours passed); null or absent while they are kept. */
    results_deleted_at?: string | null;
}
interface BatchResultBase {
    custom_id: string | null;
    /** The model build that answered (or the model the line named, if it was not answered). */
    model: string | null;
    /** The HTTP status the line got (200 when answered), or null for a line that was never run. */
    status: number | null;
    /** Tokens for this line. Batch lines are billed on `input_tokens` at the batch rate; unanswered lines are not billed. */
    usage: {
        input_tokens: number;
        output_tokens: number;
        batch: true;
    };
    /** The line as the server sent it. */
    raw: Record<string, unknown>;
}
/** An answered line: `response` is the decision, exactly as `decide` would return it. */
export interface AnsweredBatchResult<Q extends Questions = Questions> extends BatchResultBase {
    ok: true;
    response: DecisionResponse<Q>;
    error?: undefined;
}
/** A line that was not answered: `error` says why, e.g. type "expired", "cancelled" or a refusal such as "invalid_question". */
export interface FailedBatchResult extends BatchResultBase {
    ok: false;
    response?: undefined;
    error: {
        error?: string;
        type?: string;
        [key: string]: unknown;
    };
}
/** One line of a batch's results, in input order. Check `ok` to tell which kind it is. */
export type BatchResult<Q extends Questions = Questions> = AnsweredBatchResult<Q> | FailedBatchResult;
export interface CreateBatchOptions {
    /**
     * An https address to tell when the batch ends. It receives one POST of `{ id, status }`, never results. It must resolve
     * to public addresses only.
     */
    webhookUrl?: string;
    /**
     * Identifies this submission (1 to 255 printable ASCII characters); a random one is made when it is not given, and
     * the same key goes with every retry. Pass your own and submit again with it after an error you are unsure about (a
     * lost connection, a timeout): if the first submission was stored, no second batch is made and
     * `IdempotencyKeyAlreadyUsedError` is thrown, its `batchId` naming the first batch (follow it with `retrieve`). Lines
     * need no key: each is identified by its `custom_id`.
     */
    idempotencyKey?: string;
}
export interface WaitForOptions {
    /** The first wait between checks, in milliseconds (the first check is made at once). At least 1000; default 5000. */
    pollInterval?: number;
    /** The longest wait between checks, in milliseconds. Each wait is 1.5 times the last, up to this. At least 1000; default 60000. */
    maxInterval?: number;
    /** Give up after this many milliseconds (throws `BatchTimeoutError`). Default 25 hours, past the 24-hour window. */
    timeout?: number;
    /** Stop waiting early, including during a status request: `waitFor` rejects with the signal's reason. The batch itself is not cancelled. */
    signal?: AbortSignal;
    /** Called with each status read while waiting. */
    onPoll?: (batch: Batch) => void;
}
/** `waitFor` ran out of time. The batch keeps running; `batch` is its last status read (undefined if none was). */
export declare class BatchTimeoutError extends LaunchablesError {
    readonly batch: Batch | undefined;
    constructor(message: string, batch: Batch | undefined);
}
/** The transport the client gives this class: JSON requests, raw-body requests and a streamed response. */
export interface BatchTransport {
    json(method: "GET" | "POST", path: string, init?: {
        body?: string;
        contentType?: string;
        headers?: Record<string, string>;
        create?: boolean;
        signal?: AbortSignal;
    }): Promise<Record<string, unknown>>;
    lines(path: string): AsyncGenerator<string>;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
/** Checks every line before anything is sent and returns the JSONL body. Throws `ValidationError` naming the line. */
export declare function toJSONL(lines: readonly BatchLine[]): string;
export declare function parseResult<Q extends Questions = Questions>(data: Record<string, unknown>): BatchResult<Q>;
/** The Batch API: many decisions in one file, answered within 24 hours at half the live price. */
export declare class Batches {
    private readonly t;
    constructor(t: BatchTransport);
    /**
     * Submit a batch. Every line is checked here first (`ValidationError` names the line), then the server checks every
     * line again and refuses the whole batch if any is invalid (`InvalidRequestError` with `type` "invalid_batch" and the
     * lines in `body.errors`), so nothing is queued half-way.
     */
    create(lines: readonly BatchLine[], options?: CreateBatchOptions): Promise<CreatedBatch>;
    /** Every batch of the calling key, oldest first (until it is deleted). */
    list(): Promise<Batch[]>;
    /** A batch's status and counts. */
    retrieve(id: string): Promise<Batch>;
    /**
     * Stop a batch. Lines already answered stay in the results and are billed; the rest read as cancelled and are not.
     * Cancelling a cancelled batch is not an error; a batch already done or failed throws `ConflictError` (`type`
     * "batch_finished").
     */
    cancel(id: string): Promise<Batch>;
    /**
     * Every result line, read as it arrives: one per input line, in input order. Use this for large batches, so the whole
     * file is never held in memory. Throws `ConflictError` (`type` "batch_not_finished") until the batch has ended.
     *
     * Results can be downloaded once: they are deleted as soon as they have been sent in full, and results never downloaded
     * are deleted 24 hours after the batch finished. After that this throws `BatchResultsDeletedError` (410), so keep what
     * you read.
     */
    streamResults<Q extends Questions = Questions>(id: string): AsyncGenerator<BatchResult<Q>>;
    /**
     * Every result line at once, in input order. For large batches prefer `streamResults`. Results can be downloaded once
     * (see `streamResults`); a later call throws `BatchResultsDeletedError`.
     */
    results<Q extends Questions = Questions>(id: string): Promise<BatchResult<Q>[]>;
    /**
     * Polls the batch until it has ended and its results can be collected, waiting longer between checks each time
     * (`pollInterval`, times 1.5 each check, up to `maxInterval`). Resolves with the final status; it does not cancel the
     * batch when it gives up.
     */
    waitFor(id: string, options?: WaitForOptions): Promise<Batch>;
}
/**
 * Whether a batch's results can be collected: done or failed, or cancelled with every line accounted for (lines that were
 * in progress when it was cancelled still come back, and are billed, before its results are ready). A cancelled batch
 * whose counts never add up (its lines could not be read back) is taken as finished 10 minutes after the cancel.
 */
export declare function finished(batch: Batch, now?: number): boolean;
export {};
