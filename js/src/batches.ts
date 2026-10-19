import { LaunchablesError, ValidationError } from "./errors.js";
import { validateQuestions, type Questions } from "./questions.js";
import { validateAssets, validateImageBudget, type Assets, type ImageBudget } from "./images.js";
import { parseResponse, type DecisionResponse } from "./types.js";

/** A `custom_id`: 1 to 64 letters, digits or `_ . : -`, unique in its batch. */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The statuses after which a batch never changes again. */
export const BATCH_FINISHED_STATUSES = ["done", "failed", "cancelled"] as const;

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
  counts: { done: number; failed: number; pending: number };
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
  /** When the batch and its results are deleted; null while it runs. */
  delete_after: string | null;
}

/** One line of a batch's results, in input order. */
export interface BatchResult<Q extends Questions = Questions> {
  custom_id: string | null;
  /** The model build that answered (or the model the line named, if it was not answered). */
  model: string | null;
  /** The HTTP status the line got (200 when answered), or null for a line that was never run. */
  status: number | null;
  /** True when the line was answered: `response` is set and `error` is not. */
  ok: boolean;
  /** The decision, exactly as `decide` would return it. */
  response?: DecisionResponse<Q>;
  /** Why the line was not answered: `{ error, type }`, e.g. type "expired", "cancelled" or a refusal such as "invalid_question". */
  error?: { error?: string; type?: string; [key: string]: unknown };
  /** Tokens for this line. Batch lines are billed on `input_tokens` at the batch rate; unanswered lines are not billed. */
  usage: { input_tokens: number; output_tokens: number; batch: true };
  /** The line as the server sent it. */
  raw: Record<string, unknown>;
}

export interface CreateBatchOptions {
  /**
   * An https address to tell when the batch ends. It receives one POST of `{ id, status }`, never results. It must resolve
   * to public addresses only.
   */
  webhookUrl?: string;
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

/** `waitFor` ran out of time. The batch keeps running; `batch` is its last status. */
export class BatchTimeoutError extends LaunchablesError {
  readonly batch: Batch;
  constructor(message: string, batch: Batch) {
    super(message);
    this.batch = batch;
  }
}

/** The transport the client gives this class: JSON requests, raw-body requests and a streamed response. */
export interface BatchTransport {
  json(
    method: "GET" | "POST",
    path: string,
    init?: { body?: string; contentType?: string; headers?: Record<string, string>; create?: boolean; signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  lines(path: string): AsyncGenerator<string>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

const batchPath = (id: string) => {
  if (typeof id !== "string" || !/^batch_[0-9a-f]{24}$/.test(id)) {
    throw new ValidationError(`not a batch id: ${JSON.stringify(id)} (ids look like "batch_" and 24 hex digits)`);
  }
  return `/v1/batches/${id}`;
};

/** Checks every line before anything is sent and returns the JSONL body. Throws `ValidationError` naming the line. */
export function toJSONL(lines: readonly BatchLine[]): string {
  if (!Array.isArray(lines) || lines.length === 0) throw new ValidationError("a batch needs at least one line");
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as BatchLine; // a hole in a sparse array is undefined, refused below
    let where = `line ${i + 1}`;
    if (typeof line !== "object" || line === null || Array.isArray(line)) throw new ValidationError(`${where}: must be an object`);
    const { custom_id, model, state, questions, assets, image_budget } = line;
    if (typeof custom_id !== "string" || !CUSTOM_ID_PATTERN.test(custom_id)) {
      throw new ValidationError(`${where}: custom_id must be 1 to 64 letters, digits or _ . : -`);
    }
    where += ` (custom_id ${custom_id})`;
    if (seen.has(custom_id)) throw new ValidationError(`${where}: custom_id is used on an earlier line`);
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
          if (typeof (image as { data_base64?: unknown }).data_base64 !== "string") {
            throw new ValidationError(`asset "${ref}" must be inline (data_base64): a batch line cannot carry file parts`);
          }
        }
      }
      if (image_budget !== undefined) validateImageBudget(image_budget);
    } catch (e) {
      if (e instanceof ValidationError) throw new ValidationError(`${where}: ${e.serverMessage}`);
      throw e;
    }
    out.push(JSON.stringify(line));
  }
  return out.join("\n") + "\n";
}

export function parseResult<Q extends Questions = Questions>(data: Record<string, unknown>): BatchResult<Q> {
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const result: BatchResult<Q> = {
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
      result.response = parseResponse<Q>(response as Record<string, unknown>);
      result.ok = true;
    } catch {
      result.error = { error: "the answer could not be read by this version of the client", type: "unreadable_answer" };
    }
  } else if (typeof data.error === "object" && data.error !== null) {
    result.error = data.error as BatchResult["error"];
  } else {
    result.error = { error: typeof data.error === "string" ? data.error : "this line was not answered" };
  }
  return result;
}

/** The Batch API: many decisions in one file, answered within 24 hours at half the live price. */
export class Batches {
  constructor(private readonly t: BatchTransport) {}

  /**
   * Submit a batch. Every line is checked here first (`ValidationError` names the line), then the server checks every
   * line again and refuses the whole batch if any is invalid (`InvalidRequestError` with `type` "invalid_batch" and the
   * lines in `body.errors`), so nothing is queued half-way.
   */
  async create(lines: readonly BatchLine[], options: CreateBatchOptions = {}): Promise<CreatedBatch> {
    const body = toJSONL(lines);
    if (options.webhookUrl !== undefined && (typeof options.webhookUrl !== "string" || !options.webhookUrl.startsWith("https://"))) {
      throw new ValidationError("webhookUrl must be an https address");
    }
    const headers: Record<string, string> = options.webhookUrl ? { "Launchables-Webhook-Url": options.webhookUrl } : {};
    return (await this.t.json("POST", "/v1/batches", { body, contentType: "application/jsonl", headers, create: true })) as unknown as CreatedBatch;
  }

  /** Every batch of the calling key, oldest first (until it is deleted). */
  async list(): Promise<Batch[]> {
    const data = await this.t.json("GET", "/v1/batches");
    return (data.data as Batch[] | undefined) ?? [];
  }

  /** A batch's status and counts. */
  async retrieve(id: string): Promise<Batch> {
    return (await this.t.json("GET", batchPath(id))) as unknown as Batch;
  }

  /**
   * Stop a batch. Lines already answered stay in the results and are billed; the rest read as cancelled and are not.
   * Cancelling a cancelled batch is not an error; a batch already done or failed throws `ConflictError` (`type`
   * "batch_finished").
   */
  async cancel(id: string): Promise<Batch> {
    return (await this.t.json("POST", `${batchPath(id)}/cancel`)) as unknown as Batch;
  }

  /**
   * Every result line, read as it arrives: one per input line, in input order. Use this for large batches, so the whole
   * file is never held in memory. Throws `ConflictError` (`type` "batch_not_finished") until the batch has ended. The first
   * collection starts the retention clock.
   */
  async *streamResults<Q extends Questions = Questions>(id: string): AsyncGenerator<BatchResult<Q>> {
    for await (const line of this.t.lines(`${batchPath(id)}/results`)) {
      let data: unknown;
      try {
        data = JSON.parse(line);
      } catch {
        throw new LaunchablesError("Server returned a results line that is not JSON", 200, line.slice(0, 500));
      }
      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new LaunchablesError("Server returned an unexpected results line", 200, data);
      }
      yield parseResult<Q>(data as Record<string, unknown>);
    }
  }

  /** Every result line at once, in input order. For large batches prefer `streamResults`. */
  async results<Q extends Questions = Questions>(id: string): Promise<BatchResult<Q>[]> {
    const out: BatchResult<Q>[] = [];
    for await (const r of this.streamResults<Q>(id)) out.push(r);
    return out;
  }

  /**
   * Polls the batch until it has ended and its results can be collected, waiting longer between checks each time
   * (`pollInterval`, times 1.5 each check, up to `maxInterval`). Resolves with the final status; it does not cancel the
   * batch when it gives up.
   */
  async waitFor(id: string, options: WaitForOptions = {}): Promise<Batch> {
    const path = batchPath(id);
    const first = options.pollInterval ?? 5_000;
    const most = options.maxInterval ?? 60_000;
    const timeout = options.timeout ?? 25 * 3_600_000;
    for (const [name, v, least] of [["pollInterval", first, 1000], ["maxInterval", most, 1000], ["timeout", timeout, 0]] as const) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < least) throw new RangeError(`${name} must be a number of milliseconds >= ${least}`);
    }
    const started = Date.now();
    let interval = first;
    for (;;) {
      options.signal?.throwIfAborted();
      const batch = (await this.t.json("GET", path, { signal: options.signal })) as unknown as Batch;
      options.signal?.throwIfAborted();
      options.onPoll?.(batch);
      if (finished(batch)) return batch;
      const left = timeout - (Date.now() - started);
      if (left <= 0) throw new BatchTimeoutError(`batch ${id} is still ${batch.status} after ${timeout} ms`, batch);
      await this.t.sleep(Math.min(interval, left), options.signal);
      interval = Math.min(interval * 1.5, most);
    }
  }
}

/**
 * Whether a batch's results can be collected: done or failed, or cancelled with every line accounted for (lines that were
 * in progress when it was cancelled still come back, and are billed, before its results are ready).
 */
export function finished(batch: Batch): boolean {
  if (batch.status === "done" || batch.status === "failed") return true;
  if (batch.status !== "cancelled") return false;
  const c = batch.counts ?? { done: 0, failed: 0, pending: 0 };
  return c.done + c.failed >= batch.lines;
}
