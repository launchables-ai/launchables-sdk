import type { Question, Questions } from "./questions.js";
export interface Usage {
    input_tokens: number;
    output_tokens: number;
}
export type Decision = "yes" | "no" | "person";
export interface DecideThresholds {
    /** Probability at or above which the answer is "yes". Default 0.9. */
    thresholdYes?: number;
    /** Probability at or below which the answer is "no". Default 0.1. */
    thresholdNo?: number;
}
/** Yes/no answer. `noul` (alias `probability`) is the probability of yes, 0 to 1. */
export declare class NoulAnswer {
    readonly noul: number;
    readonly raw: Record<string, unknown>;
    readonly type: "noul";
    constructor(noul: number, raw?: Record<string, unknown>);
    get probability(): number;
    /** "yes" if p >= thresholdYes, "no" if p <= thresholdNo, otherwise "person" (hand off to a person). */
    decide({ thresholdYes, thresholdNo }?: DecideThresholds): Decision;
}
export interface ChoiceAnswer {
    type: "choice";
    choice: string;
    probabilities: Record<string, number>;
    raw: Record<string, unknown>;
}
export interface ScoreAnswer {
    type: "score";
    score: number;
    level: number;
    probabilities: Record<string, number>;
    raw: Record<string, unknown>;
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type AnswerFor<Q extends Question> = Q extends {
    type: "noul";
} ? NoulAnswer : Q extends {
    type: "choice";
} ? ChoiceAnswer : Q extends {
    type: "score";
} ? ScoreAnswer : Answer;
export interface DecisionResponse<Q extends Questions = Questions> {
    model: string;
    answers: {
        [K in keyof Q]: AnswerFor<Q[K]>;
    };
    usage: Usage;
    raw: Record<string, unknown>;
}
export interface Model {
    id: string;
    object: string;
    owned_by: string;
}
/** The calling key, from `client.key()`. */
export interface KeyInfo {
    id: string;
    name: string | null;
    /** The last day the key works (YYYY-MM-DD), or null if it never expires. */
    expires_on: string | null;
    days_left: number | null;
    workspace: string | null;
    rate_limit_per_minute: number | null;
    daily_limit: number | null;
    /** True when the key may not be used now; `pause_reason` says why ("credit", "budget" or "model"). */
    paused: boolean;
    pause_reason?: string;
}
/** What the client last learnt about its key's expiry, from the response headers. */
export interface KeyExpiry {
    key_id: string | null;
    /** The last day the key works (YYYY-MM-DD). */
    expires_on: string;
    /** Whole days from today (UTC) to `expires_on`; 0 on the last day. */
    days_left: number;
}
type Obj = Record<string, unknown>;
export declare function parseAnswer(data: Obj): Answer;
export declare function parseResponse<Q extends Questions>(data: Obj): DecisionResponse<Q>;
export {};
