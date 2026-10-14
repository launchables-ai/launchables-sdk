export declare const MAX_QUESTIONS = 16;
export declare const MAX_OPTIONS = 26;
export interface NoulQuestion {
    type: "noul";
    instructions: string;
    criteria?: {
        true?: string;
        false?: string;
    };
}
export interface ChoiceQuestion {
    type: "choice";
    instructions: string;
    criteria: Record<string, string> | string[];
}
export interface ScoreQuestion {
    type: "score";
    instructions: string;
    /** Level descriptions, lowest first (levels are numbered from 0). */
    criteria: string[];
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;
/** A yes/no question. The answer is the probability of yes. */
export declare function noul(instructions: string, criteria?: {
    true?: string;
    false?: string;
}): NoulQuestion;
/** Pick one label. `options` is a list of labels or a { label: description } object. */
export declare function choice(instructions: string, options: string[] | Record<string, string>): ChoiceQuestion;
/** Rate on a scale. `levels` describes each level, lowest first (numbered from 0). */
export declare function score(instructions: string, levels: string[]): ScoreQuestion;
/** Check a { name: question } object before it is sent. */
export declare function validateQuestions(questions: unknown): Questions;
